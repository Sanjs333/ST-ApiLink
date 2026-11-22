import { PROFILE_FIELD, profileSource, draftFingerprint as stableGroupValue } from './state.js';

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

// Request extras belong to individual models; only transport and authentication are shared.
const MODEL_FIELDS = new Set(['custom_model', 'custom_include_body', 'custom_include_headers', 'custom_exclude_body', 'custom_prompt_post_processing']);
const SHARED_COMMANDS = ['api', 'api-url', 'secret-id', 'proxy', 'custom-connection'];

const connectionFields = fields => Object.fromEntries(Object.entries(fields ?? {}).filter(([key]) => !MODEL_FIELDS.has(key)));

export function profileConnectionValue(profile) {
    const metadata = profile?.[PROFILE_FIELD];
    const snapshot = profile?.['custom-connection'];
    return {
        mode: profile?.mode,
        source: profileSource(profile ?? {}),
        fields: metadata ? connectionFields(metadata.fields) : { ...(profile?.['api-url'] !== undefined ? { custom_url: profile['api-url'] } : {}) },
        credential: metadata?.credential ?? (profile?.['secret-id'] ? { id: profile['secret-id'] } : null),
        proxy: metadata?.proxy ?? { mode: profile?.exclude?.includes('proxy') ? 'inherit' : 'native', name: profile?.proxy ?? '' },
        snapshot: snapshot ? { excluded: snapshot.excluded, provider: snapshot.provider ? { id: snapshot.provider.id } : snapshot.provider, auth: snapshot.auth, credential: snapshot.credential, settings: connectionFields(snapshot.settings) } : null,
        excluded: (profile?.exclude ?? []).filter(field => SHARED_COMMANDS.includes(field)).sort(),
    };
}

export function sameProfileConnection(left, right) {
    return left?.mode === 'cc' && right?.mode === 'cc' && stableGroupValue(profileConnectionValue(left)) === stableGroupValue(profileConnectionValue(right));
}

/** Copy transport settings without copying a sibling's model, request extras or foreign fields. */
export function shareProfileConnection(source, target) {
    const next = structuredClone(target);
    for (const field of SHARED_COMMANDS.filter(field => field !== 'custom-connection')) {
        if (Object.hasOwn(source, field)) next[field] = structuredClone(source[field]);
        else delete next[field];
    }
    next.exclude = [...new Set([...(target.exclude ?? []).filter(field => !SHARED_COMMANDS.includes(field)), ...(source.exclude ?? []).filter(field => SHARED_COMMANDS.includes(field))])];
    if (source[PROFILE_FIELD]) {
        const metadata = structuredClone(source[PROFILE_FIELD]);
        const targetFields = target[PROFILE_FIELD]?.fields ?? target['custom-connection']?.settings ?? {};
        metadata.model = target.model ?? target[PROFILE_FIELD]?.model ?? '';
        metadata.fields = { ...connectionFields(metadata.fields), ...Object.fromEntries(Object.entries(targetFields).filter(([key]) => MODEL_FIELDS.has(key))) };
        if (metadata.source === 'custom') metadata.fields.custom_model = metadata.model;
        next[PROFILE_FIELD] = metadata;
    } else delete next[PROFILE_FIELD];
    if (source['custom-connection']) {
        const snapshot = structuredClone(source['custom-connection']);
        if (!snapshot.excluded) {
            const targetFields = target['custom-connection']?.settings ?? target[PROFILE_FIELD]?.fields ?? {};
            snapshot.settings = { ...snapshot.settings, ...Object.fromEntries(Object.entries(targetFields).filter(([key]) => MODEL_FIELDS.has(key))), custom_model: target.model ?? target[PROFILE_FIELD]?.model ?? '' };
            if (target['custom-connection']?.models) snapshot.models = structuredClone(target['custom-connection'].models);
        }
        next['custom-connection'] = snapshot;
    } else delete next['custom-connection'];
    return next;
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
