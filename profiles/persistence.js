import { draftFingerprint } from './state.js';

/** Confirm core's successful save without downloading every setting and preset again. */
export async function saveProfileSettings({ save, cancelPending = () => {}, events, savedEvent, getSavedSettings, expectedProfiles, expectedProxy = null, expectedGroups = null }) {
    const expected = new Map(expectedProfiles.map(profile => [profile.id, draftFingerprint(profile)]));
    const proxyValue = expectedProxy && draftFingerprint(expectedProxy);
    const groupsValue = expectedGroups !== null ? draftFingerprint(expectedGroups) : null;
    let confirmed = false, profilesMatch = false, proxyMatches = false, groupsMatch = false;
    const onSaved = () => {
        const settings = getSavedSettings();
        const indexed = new Map();
        for (const profile of settings?.extension_settings?.connectionManager?.profiles ?? []) {
            if (!indexed.has(profile.id)) indexed.set(profile.id, profile);
        }
        profilesMatch = [...expected].every(([id, value]) => draftFingerprint(indexed.get(id)) === value);
        proxyMatches = !expectedProxy || draftFingerprint(settings?.proxies?.find(proxy => proxy.name === expectedProxy.name)) === proxyValue;
        groupsMatch = groupsValue === null || draftFingerprint(settings?.extension_settings?.connectionWorkbench?.groups) === groupsValue;
        confirmed = true;
    };
    events.on(savedEvent, onSaved);
    try {
        cancelPending();
        const result = await save();
        if (result === false || !confirmed) throw new Error('连接方案未能保存，请重试。');
        if (!profilesMatch || !groupsMatch) throw new Error('连接方案未能完整保存，请重试。');
        if (!proxyMatches) throw new Error('当前代理设置未能完整保存，请重试。');
    } finally {
        events.removeListener(savedEvent, onSaved);
    }
}
