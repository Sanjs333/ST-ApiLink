import { captureCustomFields, normalizeCustomEndpoint, validateCustomSnapshot, CUSTOM_CONNECTION_FIELDS } from '../compat/custom-connection.js';

export const PROFILE_FIELD = 'connection-workbench';
const EXTRA_FIELDS = {
    custom: ['custom_url', 'custom_model', 'custom_include_body', 'custom_include_headers', 'custom_exclude_body', 'custom_prompt_post_processing'],
    vertexai: ['vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id'],
    azure_openai: ['azure_base_url', 'azure_deployment_name', 'azure_api_version'],
    workers_ai: ['workers_ai_account_id'],
    siliconflow: ['siliconflow_endpoint'],
    minimax: ['minimax_endpoint'],
    zai: ['zai_endpoint'],
    pollinations: ['pollinations_endpoint'],
};

export function profileSource(profile) {
    return profile[PROFILE_FIELD]?.source ?? (profile.api === 'google' ? 'makersuite' : profile.api);
}

/** Saved connection fields override a shared completion preset, including explicit empty values. */
export function profileEditorFields(profile, preset = {}) {
    const legacy = {};
    if (profile['api-url'] !== undefined) legacy.custom_url = profile['api-url'];
    if (profile['prompt-post-processing'] !== undefined) legacy.custom_prompt_post_processing = profile['prompt-post-processing'];
    return { ...preset, ...legacy, ...profile[PROFILE_FIELD]?.fields, ...profile['custom-connection']?.settings };
}

/** Resolve a frozen ID selection against current records, independent of the active search. */
export function selectedProfiles(profiles, ids) {
    const selection = new Set(ids);
    return profiles.filter(profile => selection.has(profile.id));
}

export function normalizeProxy(value = { mode: 'inherit' }) {
    if (!['inherit', 'none', 'preset'].includes(value.mode)) throw new Error('请选择继承、无代理或指定代理。');
    if (value.mode === 'preset' && (typeof value.name !== 'string' || !value.name.trim())) throw new Error('请选择一个代理预设。');
    return value.mode === 'preset' ? { mode: 'preset', name: value.name } : { mode: value.mode };
}

/** Resolve the editor's exact native selection; empty native presets mean no proxy. */
export function resolveProfileProxy(selection, presets = []) {
    if (selection === 'inherit' || selection === 'none') return { mode: selection };
    if (typeof selection !== 'string' || !selection.startsWith('preset:')) throw new Error('请选择继承、无代理或指定代理。');
    const name = selection.slice(7);
    const preset = presets.find(entry => entry.name === name);
    if (!preset) {
        if (!name.trim()) return { mode: 'none' };
        throw new Error('代理预设已失效，请重新选择。');
    }
    if (!String(preset.url ?? '').trim() && !String(preset.password ?? '').trim()) return { mode: 'none' };
    if (!name.trim()) throw new Error('请先为这个代理预设设置名称。');
    // Core looks up proxy presets by exact name, so retain significant surrounding whitespace.
    return normalizeProxy({ mode: 'preset', name });
}

/** Ensure a named native preset can represent a direct connection, without replacing user presets. */
export function ensureNoProxyPreset(presets) {
    // Native connection loading reads these fields literally: whitespace is not an empty URL.
    const empty = preset => typeof preset.name === 'string' && Boolean(preset.name.trim())
        && String(preset.url ?? '') === '' && String(preset.password ?? '') === ''
        && presets.find(entry => entry.name === preset.name) === preset;
    const existing = presets.find(preset => preset.name === 'None' && empty(preset)) ?? presets.find(empty);
    if (existing) return { name: existing.name, created: false };
    const base = '不使用反向代理';
    let name = base;
    for (let number = 2; presets.some(preset => preset.name === name); number++) name = `${base} ${number}`;
    presets.push({ name, url: '', password: '' });
    return { name, created: true };
}

export function normalizeMetadata(value) {
    if (!value || value.version !== 1) throw new Error('此连接方案格式暂不支持，请保留原方案。');
    if (typeof value.source !== 'string' || typeof value.model !== 'string') throw new Error('连接方案缺少来源或模型。');
    const fields = {};
    for (const field of EXTRA_FIELDS[value.source] ?? []) {
        if (value.fields?.[field] !== undefined) {
            if (typeof value.fields[field] !== 'string') throw new Error('连接设置必须是文本。');
            fields[field] = value.fields[field];
        }
    }
    const credential = value.credential == null ? null : { key: value.credential.key, id: value.credential.id };
    if (credential && (typeof credential.key !== 'string' || !/^(api_key_[a-z0-9_]+|vertexai_service_account_json)$/.test(credential.key) || typeof credential.id !== 'string' || !credential.id)) throw new Error('请选择有效的已保存密钥。');
    return { version: 1, source: value.source, model: value.model, fields, proxy: normalizeProxy(value.proxy), credential };
}

export function captureMetadata(settings, model, proxy, credential = null) {
    const source = settings.chat_completion_source;
    const fields = Object.fromEntries((EXTRA_FIELDS[source] ?? []).map(field => [field, settings[field] ?? '']));
    return normalizeMetadata({ version: 1, source, model, fields, proxy, credential });
}

/** Validate the final edited tuple directly, rather than validating an already broken old binding first. */
export function editedCustomSnapshot(profile, settings, credential) {
    const previous = profile['custom-connection'];
    if (previous && previous.version !== 1) throw new Error('此 Custom 方案格式暂不支持，请保留原方案。');
    const base = previous && !previous.excluded ? previous : {
        provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false },
        credential: { mode: 'legacy-custom', id: profile['secret-id'] ?? null },
    };
    const next = credential ?? base.credential;
    return validateCustomSnapshot({ version: 1, settings: captureCustomFields(settings, true), provider: base.provider, models: base.models, auth: base.auth, credential: next });
}

export function keyBinding(profile) {
    const snapshot = profile['custom-connection'];
    if (snapshot && !snapshot.excluded) {
        const credential = snapshot.credential;
        if (credential?.mode === 'reference') return { key: credential.key, id: credential.id };
        if (credential?.mode === 'legacy-custom' && credential.id) return { key: 'api_key_custom', id: credential.id };
        return null;
    }
    return profile[PROFILE_FIELD]?.credential ?? null;
}

export function profileProblems(profile, vault, nativeKey = null) {
    const problems = [];
    try {
        if (profile[PROFILE_FIELD]) normalizeMetadata(profile[PROFILE_FIELD]);
        if (profile['custom-connection'] && !profile['custom-connection'].excluded) validateCustomSnapshot(profile['custom-connection']);
    } catch { problems.push('连接或密钥地址绑定需要修复'); }
    const binding = keyBinding(profile) ?? (profile['secret-id'] && nativeKey ? { key: nativeKey, id: profile['secret-id'] } : null);
    if (binding && !vault[binding.key]?.some(entry => entry.id === binding.id)) problems.push('保存的密钥已删除，请重新选择');
    if (profile['custom-connection']?.excluded) problems.push('此方案继承当前 Custom 连接');
    return problems;
}

export function approvedCredential(key, id, endpoint) {
    return { mode: 'reference', key, id, endpoint: normalizeCustomEndpoint(endpoint) };
}

function profileKeyReference(profile, sourceKey) {
    const binding = keyBinding(profile);
    if (binding) return binding;
    // An atomic Custom snapshot defines authentication; stale legacy fields must not override it.
    if (profile['custom-connection'] && !profile['custom-connection'].excluded) return null;
    const id = profile['secret-id'];
    if (!id) return null;
    const key = sourceKey?.(profileSource(profile), profile[PROFILE_FIELD]?.fields ?? {});
    return key ? { key, id } : null;
}

export function referencingProfiles(profiles, key, id, sourceKey) {
    return profiles.filter(profile => {
        const binding = profileKeyReference(profile, sourceKey);
        return binding?.key === key && binding.id === id;
    });
}

/** Index effective references once when presenting a large vault or merge preview. */
export function indexSecretReferences(profiles, sourceKey) {
    const index = new Map();
    for (const profile of profiles) {
        const binding = profileKeyReference(profile, sourceKey);
        if (!binding) continue;
        const token = JSON.stringify([binding.key, binding.id]);
        if (!index.has(token)) index.set(token, []);
        index.get(token).push(profile);
    }
    return index;
}

/** Preview deletion of only stored keys that the selected profiles explicitly reference. */
export function profileDeletionKeys(targetProfiles, allProfiles, vault, resolveSourceKey) {
    const targets = new Set(targetProfiles.map(profile => profile.id));
    const token = binding => JSON.stringify([binding.key, binding.id]);
    const remaining = new Set();
    for (const profile of allProfiles) {
        if (targets.has(profile.id)) continue;
        const binding = profileKeyReference(profile, resolveSourceKey);
        if (binding) remaining.add(token(binding));
    }
    const candidates = new Map();
    const recordsByKey = new Map();
    for (const profile of targetProfiles) {
        const binding = profileKeyReference(profile, resolveSourceKey);
        if (!binding) continue;
        if (!recordsByKey.has(binding.key)) {
            const byId = new Map();
            for (const entry of vault[binding.key] ?? []) if (!byId.has(entry.id)) byId.set(entry.id, entry);
            recordsByKey.set(binding.key, byId);
        }
        const record = recordsByKey.get(binding.key).get(binding.id);
        if (!record) continue;
        candidates.set(token(binding), { key: binding.key, id: binding.id, label: record.label ?? '' });
    }
    const removable = [], retained = [];
    for (const [reference, entry] of candidates) (remaining.has(reference) ? retained : removable).push(entry);
    return { removable, retained };
}

/** Comparable connection state. Sampling, discovered models and provider display labels are omitted. */
export function connectionDraftValue({ mainApi, metadata, reverseProxy = '', proxyPassword = '', customState = null }) {
    const fields = { ...(metadata?.fields ?? {}) };
    // The selected model already has its own canonical field.
    delete fields.custom_model;
    return {
        mainApi,
        source: metadata?.source ?? '',
        model: metadata?.model ?? '',
        fields,
        credential: metadata?.credential ?? null,
        proxy: { ...(metadata?.proxy ?? { mode: 'inherit' }), address: reverseProxy ?? '', password: proxyPassword ?? '' },
        custom: metadata?.source === 'custom' && customState ? {
            provider: customState.provider?.id ?? null,
            auth: customState.auth ?? null,
            credential: customState.credential ?? null,
        } : null,
    };
}

export function draftFingerprint(value) {
    if (Array.isArray(value)) return '[' + value.map(draftFingerprint).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + draftFingerprint(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

/** Start a fresh manual connection without borrowing the vault's active key. */
export function emptyCustomConnection() {
    return {
        version: 1, provider: null, settings: Object.fromEntries(CUSTOM_CONNECTION_FIELDS.map(field => [field, ''])),
        models: { mode: 'discover' }, auth: { mode: 'bearer', required: false }, credential: { mode: 'unbound' },
    };
}

/** Clear entered connection values while retaining the current API source and generation preset. */
export function emptyConnectionFields(source, modelSources) {
    const result = { reverse_proxy: '', proxy_password: '' };
    const modelField = modelSources[source]?.field ?? (source === 'azure_openai' ? 'azure_openai_model' : source === 'custom' ? 'custom_model' : null);
    if (modelField) result[modelField] = '';
    if (source === 'custom') Object.assign(result, emptyCustomConnection().settings);
    if (source === 'vertexai') Object.assign(result, { vertexai_auth_mode: 'express', vertexai_region: '', vertexai_express_project_id: '' });
    if (source === 'azure_openai') Object.assign(result, { azure_base_url: '', azure_deployment_name: '', azure_api_version: '' });
    if (source === 'workers_ai') result.workers_ai_account_id = '';
    return result;
}
