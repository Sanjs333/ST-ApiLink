

const DAY_MS = 86_400_000;
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const secretToken = (key, id) => JSON.stringify([key, id]);

export function matchesIdleDays(timestamp, days, now = Date.now()) {
    if (!Number(days)) return true;
    const time = validTime(timestamp);
    return time !== null && now - time >= Number(days) * DAY_MS;
}

/** Unknown history always stays below dated records in either direction. */
export function compareUsageTimes(aTimestamp, bTimestamp, oldestFirst = false) {
    const a = validTime(aTimestamp), b = validTime(bTimestamp);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return oldestFirst ? a - b : b - a;
}

export function describeUsage(timestamp, now = Date.now()) {
    const time = validTime(timestamp);
    if (time === null) return { text: '未记录', title: '尚无使用记录；启用此功能之前的历史无法追溯。' };
    const elapsed = Math.max(0, now - time);
    const text = elapsed < 60_000 ? '刚刚' : elapsed < 3_600_000 ? Math.floor(elapsed / 60_000) + ' 分钟前'
        : elapsed < DAY_MS ? Math.floor(elapsed / 3_600_000) + ' 小时前' : Math.floor(elapsed / DAY_MS) + ' 天前';
    return { text, title: new Date(time).toLocaleString() };
}

/** Only vault categories, record IDs and timestamps are persisted. */
export function createUsageHistory({ getSettings, save, now = Date.now }) {
    const subscribers = new Set();
    let disposed = false;
    function records(create = false) {
        const settings = getSettings();
        if (!settings || typeof settings !== 'object') return null;
        if (!settings.usage && create) settings.usage = { version: 1, profiles: {}, secrets: {} };
        const usage = settings.usage;
        if (!usage || usage.version !== 1) return null;
        if (create) {
            if (!usage.profiles || typeof usage.profiles !== 'object' || Array.isArray(usage.profiles)) usage.profiles = {};
            if (!usage.secrets || typeof usage.secrets !== 'object' || Array.isArray(usage.secrets)) usage.secrets = {};
        }
        return usage;
    }
    function changed() {
        save();
        for (const listener of subscribers) { try { listener(); } catch { /* UI observers must not interrupt requests. */ } }
    }
    function record(kind, id, timestamp = now()) {
        if (disposed || typeof id !== 'string' || !id || validTime(timestamp) === null) return;
        const store = records(true)?.[kind];
        if (!store) return;
        const previous = Object.hasOwn(store, id) ? validTime(store[id]) : null;
        if (previous !== null && previous >= timestamp) return;
        Object.defineProperty(store, id, { value: timestamp, writable: true, enumerable: true, configurable: true });
        changed();
    }
    return {
        profileTime: id => { const store = records()?.profiles; return store && Object.hasOwn(store, id) ? validTime(store[id]) : null; },
        secretTime: (key, id) => { const store = records()?.secrets, token = secretToken(key, id); return store && Object.hasOwn(store, token) ? validTime(store[token]) : null; },
        recordProfile: (id, timestamp) => record('profiles', id, timestamp),
        recordSecret: (key, id, timestamp) => { if (typeof key === 'string' && key && typeof id === 'string' && id) record('secrets', secretToken(key, id), timestamp); },
        mergeSecret(from, to) {
            const store = records()?.secrets;
            if (!store || disposed) return;
            const fromToken = secretToken(from.key, from.id), toToken = secretToken(to.key, to.id);
            const fromTime = Object.hasOwn(store, fromToken) ? validTime(store[fromToken]) : null;
            const toTime = Object.hasOwn(store, toToken) ? validTime(store[toToken]) : null;
            if (fromTime !== null && (toTime === null || fromTime > toTime)) record('secrets', toToken, fromTime);
        },
        prune(profiles, vault) {
            const usage = records();
            if (!usage || disposed) return;
            const profileIds = new Set(profiles.map(profile => profile.id));
            const secretIds = new Set(Object.entries(vault).flatMap(([key, entries]) =>
                Array.isArray(entries) ? entries.map(entry => secretToken(key, entry.id)) : []));
            let dirty = false;
            for (const id of Object.keys(usage.profiles ?? {})) if (!profileIds.has(id)) { delete usage.profiles[id]; dirty = true; }
            for (const token of Object.keys(usage.secrets ?? {})) if (!secretIds.has(token)) { delete usage.secrets[token]; dirty = true; }
            if (dirty) changed();
        },
        subscribe(listener) { if (disposed) return () => {}; subscribers.add(listener); return () => subscribers.delete(listener); },
        cleanup() { disposed = true; subscribers.clear(); },
    };
}

const PROXY_AUTH_SOURCES = new Set(['openai', 'claude', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot']);

/** Resolve the dispatched request, not the connection currently displayed in the UI. */
export function requestSecretReference(data, vault, resolveSourceKey) {
    if (!data || typeof data !== 'object' || data.dryRun || data.dry_run) return null;
    const source = data.chat_completion_source;
    if (typeof source !== 'string') return null;
    if (data.reverse_proxy && PROXY_AUTH_SOURCES.has(source)) return null;
    let key, id;
    if (source === 'custom' && data.custom_auth !== undefined) {
        const envelope = data.custom_auth;
        if (envelope?.version !== 1 || envelope.auth?.mode === 'none') return null;
        const credential = envelope.credential;
        if (credential?.mode === 'reference') { key = credential.key; id = credential.id; }
        else if (credential?.mode === 'legacy-custom' && credential.id) { key = 'api_key_custom'; id = credential.id; }
        else return null;
    } else {
        // Anonymous Pollinations requests send no saved key.
        if (source === 'pollinations' && data.pollinations_endpoint === 'anonymous') return null;
        key = resolveSourceKey(source, data);
        if (!key) return null;
        // Native Vertex authentication reads the active entry, including background requests.
        if (source !== 'vertexai' && Object.hasOwn(data, 'secret_id') && data.secret_id) id = data.secret_id;
        else id = vault[key]?.find(entry => entry.active)?.id;
    }
    return typeof key === 'string' && typeof id === 'string' && vault[key]?.some(entry => entry.id === id) ? { key, id } : null;
}

/** Observe only same-origin dispatches; preserve arguments, promise, errors and body untouched. */
export function observeUsageRequests({ target, usage, getVault, resolveSourceKey, baseUrl }) {
    if (!target || typeof target.fetch !== 'function') return () => {};
    const original = target.fetch;
    let stopped = false;
    let base;
    try { base = new URL(baseUrl); } catch { /* Invalid bases leave usage observation inactive. */ }
    function observedFetch(...args) {
        let reference = null;
        if (!stopped) {
            try {
                const [input, options] = args;
                const body = options?.body;
                const signal = options?.signal ?? input?.signal;
                const method = options?.method ?? input?.method ?? 'GET';
                // Most host fetches are polling, settings or assets. Skip URL parsing for
                // requests that cannot contain an observable completion dispatch.
                if (base && String(method).toUpperCase() === 'POST' && typeof body === 'string' && !signal?.aborted) {
                    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, base);
                    if (url.origin === base.origin && /^\/api\/backends\/chat-completions\/(generate|status)$/.test(url.pathname)) {
                        reference = requestSecretReference(JSON.parse(body), getVault(), resolveSourceKey);
                    }
                }
            } catch { /* Unsupported bodies and URLs remain unobserved. */ }
        }
        const result = Reflect.apply(original, this, args);
        if (reference && !stopped) {
            try { usage.recordSecret(reference.key, reference.id); } catch { /* History must never change request behavior. */ }
        }
        return result;
    }
    target.fetch = observedFetch;
    return () => { stopped = true; if (target.fetch === observedFetch) target.fetch = original; };
}
