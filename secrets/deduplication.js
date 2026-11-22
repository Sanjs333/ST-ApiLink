import { keyBinding, profileSource, referencingProfiles, PROFILE_FIELD } from '../profiles/state.js';

const sameBinding = (binding, entry) => binding?.key === entry.key && binding.id === entry.id;
const validEntry = entry => typeof entry?.key === 'string' && Boolean(entry.key)
    && typeof entry.id === 'string' && Boolean(entry.id);
const entryToken = entry => JSON.stringify([entry.key, entry.id]);
const publicEntry = entry => ({ key: entry.key, id: entry.id, label: entry.label ?? '', active: Boolean(entry.active) });

/** Group hashes of complete values within their native service, never masked display values. */
export function groupDuplicateSecrets(entries) {
    const groups = new Map(), seen = new Set();
    for (const entry of entries) {
        if (!validEntry(entry) || typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.fingerprint)) continue;
        const token = entryToken(entry);
        if (seen.has(token)) continue;
        seen.add(token);
        const groupToken = JSON.stringify([entry.key, entry.fingerprint.toLowerCase()]);
        const group = groups.get(groupToken) ?? [];
        group.push(publicEntry(entry));
        groups.set(groupToken, group);
    }
    return [...groups.values()].filter(group => group.length > 1).map(group => {
        const keep = group.find(entry => entry.active) ?? group[0];
        return { keep, duplicates: group.filter(entry => entry !== keep) };
    });
}

/** Replace only an effective saved credential, retaining its existing endpoint approval and fields. */
export function rebindProfileSecret(profile, from, to, resolveSourceKey) {
    if (!validEntry(from) || !validEntry(to) || from.key !== to.key) throw new Error('密钥合并只能使用同一服务的有效密钥。');
    if (from.id === to.id) return null;
    const snapshot = profile['custom-connection'];
    const binding = keyBinding(profile);
    const nativeKey = resolveSourceKey?.(profileSource(profile), profile[PROFILE_FIELD]?.fields ?? {});
    const effective = binding ?? (!snapshot || snapshot.excluded ? profile['secret-id'] && nativeKey ? { key: nativeKey, id: profile['secret-id'] } : null : null);
    if (!sameBinding(effective, from)) return null;

    const next = structuredClone(profile);
    if (snapshot && !snapshot.excluded) {
        // keyBinding excludes none, unbound and empty legacy credentials, so these remain untouched.
        next['custom-connection'].credential.id = to.id;
    }
    if (sameBinding(next[PROFILE_FIELD]?.credential, from)) next[PROFILE_FIELD].credential.id = to.id;
    if (nativeKey === from.key && next['secret-id'] === from.id) next['secret-id'] = to.id;
    return next;
}

/** Persist replacement references before deleting, and recheck each approved pair against current state. */
export async function mergeDuplicateSecrets({
    groups, getProfiles, getVault, resolveSourceKey, rebindReferences, removeKey, verifyDuplicate,
    shouldStop = () => false, onProgress = () => {},
}) {
    if (typeof verifyDuplicate !== 'function') throw new Error('合并前需要重新核对完整密钥。');
    const result = { deleted: 0, failed: 0, retained: 0, migrated: 0, stopped: false, deletedEntries: [], errors: [] };
    const planned = groups.flatMap(group => group.duplicates.map(entry => ({ from: publicEntry(entry), to: publicEntry(group.keep) })));
    const seen = new Set();
    const exists = entry => getVault()[entry.key]?.some(record => record.id === entry.id);
    for (let index = 0; index < planned.length; index++) {
        if (shouldStop()) break;
        const { from, to } = planned[index];
        if (!validEntry(from) || !validEntry(to) || from.key !== to.key || from.id === to.id) { result.retained++; continue; }
        const token = entryToken(from);
        if (seen.has(token)) continue;
        seen.add(token);
        if (!exists(from)) continue;
        if (!exists(to)) { result.retained++; continue; }
        onProgress({ phase: 'verify', index: index + 1, total: planned.length, from, keep: to });
        if (shouldStop()) break;
        let phase = 'verify';
        try {
            if (!await verifyDuplicate(from, to)) { result.retained++; continue; }
            if (shouldStop()) break;
            if (!exists(from)) continue;
            if (!exists(to)) { result.retained++; continue; }
            phase = 'references';
            onProgress({ phase, index: index + 1, total: planned.length, from, keep: to });
            if (shouldStop()) break;
            const migration = await rebindReferences(from, to);
            result.migrated += Number.isFinite(migration?.profiles) ? Math.max(0, migration.profiles) : 0;
            if (shouldStop()) break;
            if (!exists(to)) { result.retained++; continue; }
            if (!exists(from)) continue;
            // Persistence can await network I/O; a pair may have changed since the initial check.
            phase = 'verify';
            if (!await verifyDuplicate(from, to)) { result.retained++; continue; }
            if (shouldStop()) break;
            if (!exists(to)) { result.retained++; continue; }
            if (!exists(from)) continue;
            phase = 'delete';
            onProgress({ phase, index: index + 1, total: planned.length, from, keep: to });
            if (shouldStop()) break;
            if (!exists(to)) { result.retained++; continue; }
            // A save that silently failed or a reference added while saving must prevent deletion.
            if (referencingProfiles(getProfiles(), from.key, from.id, resolveSourceKey).length) {
                result.failed++;
                result.errors.push({ key: from.key, id: from.id, phase: 'references' });
                continue;
            }
            await removeKey(from.key, from.id);
            if (exists(from)) throw new Error('密钥未能删除。');
            result.deleted++;
            result.deletedEntries.push(from);
        } catch {
            result.failed++;
            // Keep diagnostic identifiers only; error messages may contain secret values from a provider.
            result.errors.push({ key: from.key, id: from.id, phase });
        }
    }
    result.stopped = Boolean(shouldStop());
    return result;
}
