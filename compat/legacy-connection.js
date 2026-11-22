import { captureCustomFields, normalizeCustomEndpoint, validateCustomSnapshot } from './custom-connection.js';

const CUSTOM_KEY = 'api_key_custom';

/** Use the old host's exact secret-ID lookup without reading or copying secret values. */
export function createLegacyConnection({ settings, getSecrets, refresh = () => {}, changed = () => {}, supportsSecretId = () => true, suppressAuth }) {
    let paused = 0;
    const ensure = () => {
        const state = settings.custom_provider_state ??= { version: 1, active: null, manual: null, drafts: {} };
        if (state.version !== 1) throw new Error('此连接格式暂不支持，请保留原配置。');
        state.drafts ??= {};
        state.active ??= {
            provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false },
            credential: { mode: 'legacy-custom', id: getSecrets()[CUSTOM_KEY]?.find(entry => entry.active)?.id ?? null },
        };
        return state;
    };
    const capture = () => validateCustomSnapshot({ version: 1, settings: captureCustomFields(settings, true), ...ensure().active });
    function assertSupported(snapshot) {
        if (snapshot.auth.mode === 'header') throw new Error('当前酒馆版本不支持此服务商的密钥请求头，请改用普通 Custom 连接。');
        if (snapshot.credential.mode === 'reference' && snapshot.credential.key !== CUSTOM_KEY) {
            throw new Error('当前酒馆版本的 Custom 连接请使用 Custom 分类的密钥；原绑定已保留。');
        }
        return snapshot;
    }
    function restore(value, reason = 'profile restore') {
        const snapshot = assertSupported(validateCustomSnapshot(value));
        const state = ensure();
        const previous = { version: 1, settings: captureCustomFields(settings, true), ...structuredClone(state.active) };
        if (previous.provider) state.drafts[previous.provider.id] = previous;
        else state.manual = previous;
        Object.assign(settings, snapshot.settings);
        const { provider, models, auth, credential } = snapshot;
        state.active = { provider, models, auth, credential };
        if (provider) delete state.drafts[provider.id];
        else state.manual = null;
        refresh();
        changed(reason);
        return snapshot;
    }
    function selectActiveKey() {
        if (paused || settings.chat_completion_source !== 'custom') return;
        const entry = getSecrets()[CUSTOM_KEY]?.find(item => item.active);
        if (!entry) return;
        const state = ensure();
        let endpoint;
        try { endpoint = normalizeCustomEndpoint(settings.custom_url); } catch { return; }
        state.active.credential = { mode: 'reference', key: CUSTOM_KEY, id: entry.id, endpoint };
        refresh();
        changed('key selection');
    }
    function translate(body) {
        if (paused) throw new Error('连接或密钥正在切换，请稍后重试。');
        if (body.chat_completion_source !== 'custom') return body;
        const envelope = body.custom_auth;
        if (envelope && envelope.version !== 1) throw new Error('此 Custom 认证格式暂不支持。');
        const snapshot = assertSupported(validateCustomSnapshot({
            version: 1, settings: captureCustomFields({ ...settings, ...body }, true),
            ...(envelope ? { provider: null, models: { mode: 'discover' }, auth: envelope.auth, credential: envelope.credential } : ensure().active),
        }));
        const credential = snapshot.credential;
        if (credential.mode === 'unbound') throw new Error('请为当前连接选择密钥，或明确选择“不使用密钥”。');
        const id = credential.mode === 'reference' ? credential.id : credential.mode === 'legacy-custom' ? credential.id : null;
        if (id && !getSecrets()[CUSTOM_KEY]?.some(entry => entry.id === id)) throw new Error('选择的密钥已删除，请重新选择。');
        if (id && !supportsSecretId() && getSecrets()[CUSTOM_KEY]?.find(entry => entry.active)?.id !== id) {
            throw new Error('当前酒馆版本只能用已激活的密钥拉取模型，请先切换到此密钥后重试。');
        }
        const result = { ...body };
        if (id) result.secret_id = id;
        else {
            // Both old Node backends and TT merge these headers after their stored key.
            // Override the request only; keep the saved key and active selection intact.
            delete result.secret_id;
            if (typeof suppressAuth !== 'function') throw new Error('当前连接缺少免密请求适配器。');
            result.custom_include_headers = suppressAuth(body.custom_include_headers ?? settings.custom_include_headers ?? '');
        }
        delete result.custom_auth;
        delete result.custom_provider_state;
        return result;
    }
    function pause() {
        paused++;
        let released = false;
        return () => { if (!released) { released = true; paused--; } };
    }
    return { ensure, capture, restore, translate, pause, selectActiveKey, assertSupported, get paused() { return paused > 0; } };
}

/** Cover normal fetch calls and Request bodies while leaving unrelated traffic untouched. */
export function installLegacyTransport({ target, connection, baseUrl }) {
    const original = target.fetch;
    const base = new URL(baseUrl);
    let stopped = false;
    async function fetchCompatible(input, options) {
        if (stopped) return Reflect.apply(original, this, arguments);
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base);
        const method = String(options?.method ?? input?.method ?? 'GET').toUpperCase();
        if (url.origin !== base.origin || method !== 'POST' || !/^\/api\/backends\/chat-completions\/(status|generate)$/.test(url.pathname)) {
            return Reflect.apply(original, this, arguments);
        }
        const body = options?.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : undefined);
        if (typeof body !== 'string') return Reflect.apply(original, this, arguments);
        try {
            const payload = JSON.parse(body);
            const translated = connection.translate(payload);
            if (translated === payload) return Reflect.apply(original, this, arguments);
            const nextOptions = { ...options, body: JSON.stringify(translated) };
            if (typeof input?.clone === 'function') return Reflect.apply(original, this, [new Request(input, nextOptions)]);
            return Reflect.apply(original, this, [input, nextOptions]);
        } catch (error) {
            return new Response(JSON.stringify({ error: { message: error.message } }), {
                status: 409, headers: { 'Content-Type': 'application/json' },
            });
        }
    }
    target.fetch = fetchCompatible;
    return () => { stopped = true; if (target.fetch === fetchCompatible) target.fetch = original; };
}
