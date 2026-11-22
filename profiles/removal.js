import { profileDeletionKeys } from './state.js';

/** Delete a frozen profile selection, then clean up only keys whose remaining references allow it. */
export async function removeProfilesWithKeys({
    ids, getProfiles, getVault, resolveSourceKey, removeProfile, removeKey,
    deleteKeys = false, allowedKeys, onProgress = () => {}, shouldStop = () => false,
}) {
    const targets = [...new Set(ids)];
    const removed = [];
    const result = { completed: 0, failed: 0, keysDeleted: 0, keysRetained: 0, keysFailed: 0, removedIds: [] };
    for (let index = 0; index < targets.length; index++) {
        if (shouldStop()) break;
        const profile = getProfiles().find(entry => entry.id === targets[index]);
        if (!profile) continue;
        const snapshot = structuredClone(profile);
        onProgress({ phase: 'profiles', index: index + 1, total: targets.length });
        try {
            const success = await removeProfile(profile);
            if (!success || getProfiles().some(entry => entry.id === snapshot.id)) { result.failed++; continue; }
            removed.push(snapshot);
            result.removedIds.push(snapshot.id);
            result.completed++;
        } catch { result.failed++; }
    }
    if (!deleteKeys || shouldStop()) return result;
    const plan = profileDeletionKeys(removed, getProfiles(), getVault(), resolveSourceKey);
    const approved = allowedKeys && new Set(allowedKeys.map(entry => JSON.stringify([entry.key, entry.id])));
    result.keysRetained = plan.retained.length;
    for (let index = 0; index < plan.removable.length; index++) {
        if (shouldStop()) break;
        const candidate = plan.removable[index];
        if (approved && !approved.has(JSON.stringify([candidate.key, candidate.id]))) { result.keysRetained++; continue; }
        onProgress({ phase: 'keys', index: index + 1, total: plan.removable.length });
        if (shouldStop()) break;
        // An extension or another dialog may have added a reference while deletion was running.
        const latest = profileDeletionKeys(removed, getProfiles(), getVault(), resolveSourceKey);
        const same = entry => entry.key === candidate.key && entry.id === candidate.id;
        if (latest.retained.some(same)) { result.keysRetained++; continue; }
        if (!latest.removable.some(same)) continue;
        try {
            await removeKey(candidate.key, candidate.id);
            if (getVault()[candidate.key]?.some(entry => entry.id === candidate.id)) result.keysFailed++;
            else result.keysDeleted++;
        } catch { result.keysFailed++; }
    }
    return result;
}
