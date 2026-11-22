import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDuplicateSecrets } from '../secrets/deduplication.js';

const key = 'api_key_test';

function fixture(size = 1) {
    const keep = { key, id: 'keep' };
    const duplicates = Array.from({ length: size }, (_, index) => ({ key, id: `duplicate-${index}` }));
    const vault = { [key]: [keep, ...duplicates] };
    const calls = { verify: 0, remove: 0 };
    const options = {
        groups: [{ keep, duplicates }],
        getVault: () => vault,
        getProfiles: () => [],
        resolveSourceKey: () => key,
        verifyDuplicate: async () => { calls.verify++; return true; },
        rebindReferences: async () => ({ profiles: 0, requiresReverification: false }),
        removeKey: async (_key, id) => { calls.remove++; vault[key] = vault[key].filter(entry => entry.id !== id); },
    };
    return { options, calls, vault, keep, duplicates };
}

test('verifies each of 6500 unchanged bindings once before deletion', async () => {
    const { options, calls, vault, keep } = fixture(6500);
    const result = await mergeDuplicateSecrets(options);
    assert.equal(result.deleted, 6500);
    assert.deepEqual(calls, { verify: 6500, remove: 6500 });
    assert.deepEqual(vault[key], [keep]);
});

test('still verifies again after a binding save and retains a changed secret', async () => {
    const { options, calls } = fixture();
    let saved = false;
    options.verifyDuplicate = async () => { calls.verify++; return !saved; };
    options.rebindReferences = async () => { saved = true; return { profiles: 1 }; };
    const result = await mergeDuplicateSecrets(options);
    assert.deepEqual(calls, { verify: 2, remove: 0 });
    assert.equal(result.retained, 1);
});

test('refuses to delete when a profile still references the duplicate', async () => {
    const { options, calls, duplicates } = fixture();
    options.getProfiles = () => [{ api: 'test', 'secret-id': duplicates[0].id }];
    const result = await mergeDuplicateSecrets(options);
    assert.equal(result.errors[0].phase, 'references');
    assert.deepEqual(calls, { verify: 1, remove: 0 });
});

for (const type of ['network', 'timeout']) {
    test(`stops on ${type} and leaves the unprocessed entries in place`, async () => {
        const { options, vault, keep, duplicates, calls } = fixture(3);
        options.verifyDuplicate = async () => {
            if (++calls.verify === 2) throw Object.assign(new Error('not for diagnostics'), { type });
            return true;
        };
        const result = await mergeDuplicateSecrets(options);
        assert.equal(result.stopped, true);
        assert.equal(result.interruption, type);
        assert.equal(result.deleted, 1);
        assert.deepEqual(result.errors, [{ key, id: duplicates[1].id, phase: 'verify' }]);
        assert.deepEqual(vault[key], [keep, ...duplicates.slice(1)]);
    });
}

test('does not count a cancelled verification as a failure', async () => {
    const { options, calls } = fixture();
    let cancelled = false;
    options.shouldStop = () => cancelled;
    options.verifyDuplicate = async () => { cancelled = true; throw new DOMException('Aborted', 'AbortError'); };
    const result = await mergeDuplicateSecrets(options);
    assert.equal(result.stopped, true);
    assert.equal(result.failed, 0);
    assert.equal(calls.remove, 0);
});
