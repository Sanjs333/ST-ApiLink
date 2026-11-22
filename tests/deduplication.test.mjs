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

function batchFixture(size) {
    const { options, calls, vault, keep, duplicates } = fixture(size);
    const stored = new Set(vault[key]);
    const batches = [];
    options.removeKey = async (_key, id) => {
        calls.remove++;
        stored.delete(duplicates.find(entry => entry.id === id));
    };
    options.confirmDeletes = async batch => {
        batches.push(batch.length);
        vault[key] = [...stored];
    };
    return { options, calls, keep, duplicates, stored, batches };
}

test('confirms normal deletes in batches of 20 and flushes the tail', async () => {
    const { options, batches, calls, keep, stored } = batchFixture(45);
    const result = await mergeDuplicateSecrets(options);
    assert.deepEqual(batches, [20, 20, 5]);
    assert.deepEqual(calls, { verify: 45, remove: 45 });
    assert.equal(result.deleted, 45);
    assert.deepEqual([...stored], [keep]);
});

test('confirms an active-key switch or saved rebinding before continuing', async () => {
    const { options, batches, duplicates } = batchFixture(4);
    const remove = options.removeKey;
    options.removeKey = async (service, id) => {
        await remove(service, id);
        return { confirmImmediately: id === duplicates[1].id };
    };
    const rebind = options.rebindReferences;
    options.rebindReferences = async from => from.id === duplicates[2].id ? { profiles: 1 } : rebind();
    const result = await mergeDuplicateSecrets(options);
    assert.deepEqual(batches, [2, 1, 1]);
    assert.equal(result.deleted, 4);
});

test('manual stop still checks the pending deletes', async () => {
    const { options, calls, batches } = batchFixture(5);
    options.shouldStop = () => calls.remove === 2;
    const result = await mergeDuplicateSecrets(options);
    assert.deepEqual(batches, [2]);
    assert.equal(result.deleted, 2);
    assert.equal(result.stopped, true);
});

test('stops sending deletes when the batch cannot be confirmed', async () => {
    const { options, calls } = batchFixture(5);
    options.batchSize = 2;
    options.confirmDeletes = async () => { throw new Error('read failed'); };
    const result = await mergeDuplicateSecrets(options);
    assert.equal(calls.remove, 2);
    assert.equal(result.interruption, 'confirmation');
    assert.equal(result.unconfirmed, 2);
    assert.equal(result.deleted, 0);
});

test('reconciles a delete whose response was lost without sending more deletes', async () => {
    const { options, calls, batches } = batchFixture(5);
    const remove = options.removeKey;
    options.removeKey = async (...args) => {
        await remove(...args);
        if (calls.remove === 2) throw Object.assign(new Error('connection lost'), { type: 'network', deleteMayHaveRun: true });
    };
    const result = await mergeDuplicateSecrets(options);
    assert.deepEqual(batches, [2]);
    assert.equal(result.deleted, 2);
    assert.equal(result.interruption, 'network');
});
