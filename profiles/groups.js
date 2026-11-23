import { PROFILE_FIELD, profileSource, draftFingerprint as stableGroupValue } from './state.js';
import { PROXY_AUTH_SOURCES } from './usage.js';

/** Keep usage order within connections and stable keys for continuous scrolling. */
export function buildProfileGroupRows(profiles, groups, { collapsed = new Set(), searching = false, multi = false, emptyGroupIds = [] } = {}) {
    if (!groups.length) return [...profiles];
    const membership = new Map();
    const groupsById = new Map();
    for (const group of groups) {
        groupsById.set(group.id, group);
        for (const id of group.profileIds) membership.set(id, group);
    }
    const buckets = new Map();
    for (const profile of profiles) {
        const group = membership.get(profile.id) ?? null;
        const key = group?.id ?? '';
        if (!buckets.has(key)) buckets.set(key, { group, profiles: [] });
        buckets.get(key).profiles.push(profile);
    }
    // Retained empty groups remain manageable; nonempty groups hidden by filters stay hidden.
    if (!searching) for (const id of emptyGroupIds) {
        const group = groupsById.get(id);
        if (group && !group.profileIds.length && !buckets.has(id)) buckets.set(id, { group, profiles: [] });
    }
    const rows = [];
    for (const { group, profiles: members } of buckets.values()) {
        const expanded = !group || searching || multi || !collapsed.has(group.id);
        rows.push({ id: `cw-group:${group?.id ?? 'ungrouped'}`, kind: 'group', group,
            profileIds: members.map(profile => profile.id), count: members.length, expanded });
        if (expanded) rows.push(...members);
    }
    return rows;
}

export { stableGroupValue };

function normalizeAddress(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.username = ''; url.password = ''; url.hash = '';
        return url.href.replace(/\/+$/, '');
    } catch { return null; }
}

/** A group organizes destinations; credentials and all request settings belong to each profile. */
export function profileAddress(profile, proxyPresets = []) {
    const metadata = profile?.[PROFILE_FIELD];
    const snapshot = profile?.['custom-connection'];
    const source = profileSource(profile ?? {});
    const fields = { ...metadata?.fields, ...(!snapshot?.excluded ? snapshot?.settings : {}) };
    if (source === 'custom') return { address: normalizeAddress(fields.custom_url ?? profile?.['api-url']), sourceIfMissing: 'custom' };
    if (source === 'azure_openai') return { address: normalizeAddress(fields.azure_base_url), sourceIfMissing: 'azure_openai' };
    if (source === 'vertexai' && fields.vertexai_auth_mode === 'full') {
        const region = (fields.vertexai_region || 'us-central1').trim().toLowerCase();
        const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
        return { address: normalizeAddress(`https://${host}/v1`) };
    }
    const proxy = metadata?.proxy ?? (profile?.exclude?.includes('proxy') ? { mode: 'inherit' }
        : profile?.proxy ? { mode: 'preset', name: profile.proxy } : { mode: 'none' });
    if (proxy.mode === 'preset' && PROXY_AUTH_SOURCES.has(source)) {
        const preset = proxyPresets.find(entry => entry.name === proxy.name);
        const address = normalizeAddress(preset?.url);
        if (address) return { address };
        if (!preset) return { address: null, sourceIfMissing: source };
    }
    if (proxy.mode === 'inherit' && PROXY_AUTH_SOURCES.has(source)) return { inheritedAddress: true, source };
    if (source === 'vertexai') return { address: 'https://aiplatform.googleapis.com/v1' };
    // Native services without a configured URL are identified by their source and endpoint settings.
    return { nativeSource: source, endpoint: fields[`${source}_endpoint`] ?? null,
        ...(source === 'workers_ai' ? { account: fields.workers_ai_account_id ?? '' } : {}) };
}

export function sameProfileAddress(left, right, proxyPresets = []) {
    const leftAddress = profileAddress(left, proxyPresets), rightAddress = profileAddress(right, proxyPresets);
    // Explicit URLs can be grouped across different API request formats.
    if (Object.hasOwn(leftAddress, 'address') || Object.hasOwn(rightAddress, 'address')) return left?.mode === 'cc' && right?.mode === 'cc'
        && Boolean(leftAddress.address && rightAddress.address && leftAddress.address === rightAddress.address);
    return left?.mode === 'cc' && right?.mode === 'cc' && stableGroupValue(leftAddress) === stableGroupValue(rightAddress);
}

export function modelVariant(profile, { model, name, id }) {
    const next = structuredClone(profile);
    if (typeof model !== 'string' || !model.trim() || model.length > 512 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('请输入有效的模型 ID（最多 512 个字符）。');
    next.id = id;
    next.name = name;
    next.model = model.trim();
    delete next['reasoning-template'];
    next.exclude = [...new Set([...(next.exclude ?? []).filter(field => field !== 'model'), 'reasoning-template'])];
    if (next[PROFILE_FIELD]) {
        next[PROFILE_FIELD].model = next.model;
        if (next[PROFILE_FIELD].source === 'custom') next[PROFILE_FIELD].fields.custom_model = next.model;
    }
    if (next['custom-connection'] && !next['custom-connection'].excluded) next['custom-connection'].settings.custom_model = next.model;
    return next;
}

/** Ignore stale IDs while retaining an empty group's name for later reuse. */
export function readProfileGroups(settings, profiles) {
    const available = new Set(profiles.map(profile => profile.id));
    const assigned = new Set(), groupIds = new Set();
    const result = [];
    for (const value of Array.isArray(settings?.groups) ? settings.groups : []) {
        if (!value || typeof value.id !== 'string' || !value.id || groupIds.has(value.id) || typeof value.name !== 'string' || !value.name.trim()) continue;
        groupIds.add(value.id);
        const profileIds = [...new Set(Array.isArray(value.profileIds) ? value.profileIds : [])].filter(id => available.has(id) && !assigned.has(id));
        profileIds.forEach(id => assigned.add(id));
        result.push({ id: value.id, name: value.name, profileIds });
    }
    return result;
}
