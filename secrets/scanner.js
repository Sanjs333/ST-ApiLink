

const validEntry = entry => typeof entry?.key === 'string' && Boolean(entry.key)
    && typeof entry.id === 'string' && Boolean(entry.id);
const publicEntry = entry => ({ key: entry.key, id: entry.id, label: typeof entry.label === 'string' ? entry.label : '', active: Boolean(entry.active) });
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

function abortIfNeeded(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

function secretError(message, type, status) {
    const error = new Error(message);
    error.type = type;
    if (status !== undefined) error.status = status;
    return error;
}

/** Release every complete value returned by read, including services outside the managed scope. */
function clearSecretValues(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (Array.isArray(payload)) {
        for (const record of payload) clearSecretValues(record);
        return;
    }
    if (Object.hasOwn(payload, 'value')) payload.value = '';
    for (const [key, records] of Object.entries(payload)) {
        if (typeof records === 'string') payload[key] = '';
        if (!Array.isArray(records)) continue;
        for (const record of records) if (record && typeof record === 'object' && Object.hasOwn(record, 'value')) record.value = '';
    }
}

/** A deadline applies to this request and its JSON body, independently of scan duration. */
export async function requestSecretJson(action, {
    values = {}, headers, signal, fetchImpl = fetch, timeoutMs = 120_000,
} = {}) {
    abortIfNeeded(signal);
    if (typeof action !== 'string' || !/^[a-z-]+$/.test(action)) throw secretError('请选择有效的密钥操作。', 'validation');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw secretError('密钥读取超时设置必须是正数。', 'validation');
    const controller = new AbortController();
    let rejectCancellation;
    const cancelled = new Promise((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = reason => {
        if (controller.signal.aborted) return;
        controller.abort(reason);
        rejectCancellation(controller.signal.reason);
    };
    const onAbort = () => cancel(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => cancel(secretError(
        `读取密钥请求长时间未返回（单次请求超过${Math.ceil(timeoutMs / 1000)}秒），请重试。`, 'timeout',
    )), timeoutMs);
    const request = async () => {
        let payload;
        try {
            const response = await fetchImpl('/api/secrets/' + action, {
                method: 'POST', headers, signal: controller.signal, cache: 'no-cache', body: JSON.stringify(values),
            });
            abortIfNeeded(controller.signal);
            if (response.status === 403) throw secretError('识别重复密钥需要酒馆开启 allowKeysExposure；当前未开放完整密钥读取，无法准确识别。', 'http', 403);
            if (!response.ok) throw secretError(`读取密钥失败（HTTP ${response.status}），请重试。`, 'http', response.status);
            try { payload = await response.json(); }
            catch {
                abortIfNeeded(controller.signal);
                throw secretError('密钥接口未返回有效的 JSON 数据，请重试。', 'data');
            }
            abortIfNeeded(controller.signal);
            return payload;
        } catch (error) {
            abortIfNeeded(controller.signal);
            if (error?.type || error?.name === 'AbortError') throw error;
            throw secretError('读取密钥失败，请检查连接后重试。', 'network');
        } finally {
            // A transport may finish parsing after the deadline even if it ignores abort.
            if (controller.signal.aborted) clearSecretValues(payload);
        }
    };
    try {
        return await Promise.race([request(), cancelled]);
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Read once, then hash only categories containing at least two distinct managed IDs. */
export async function scanSecretFingerprints(entries, {
    requestSecrets, hash, signal, onProgress = () => {}, yieldImpl = yieldToBrowser,
} = {}) {
    abortIfNeeded(signal);
    if (!Array.isArray(entries) || typeof requestSecrets !== 'function' || typeof hash !== 'function') throw secretError('密钥识别参数无效，请重试。', 'validation');
    const services = new Map(), unique = [];
    for (const entry of entries) {
        if (!validEntry(entry)) continue;
        const ids = services.get(entry.key) ?? new Set();
        if (ids.has(entry.id)) continue;
        ids.add(entry.id); services.set(entry.key, ids); unique.push(publicEntry(entry));
    }
    let candidates = unique.filter(entry => services.get(entry.key).size > 1);
    onProgress({ completed: 0, total: candidates.length });
    abortIfNeeded(signal);
    if (!candidates.length) return [];

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const output = new Array(candidates.length);
    let snapshot, completed = 0, pause = null, sliceStart = performance.now();
    const read = async (action, values = {}) => {
        const payload = await requestSecrets(action, values, controller.signal);
        if (controller.signal.aborted) { clearSecretValues(payload); abortIfNeeded(controller.signal); }
        return payload;
    };
    const digest = async (record, index) => {
        abortIfNeeded(controller.signal);
        if (typeof record?.value !== 'string' || !record.value) throw secretError('密钥已不存在或无法读取，请重新识别。', 'data');
        let fingerprint;
        try { fingerprint = await hash(record.value); }
        catch { throw secretError('密钥核对失败，请重新识别。', 'data'); }
        abortIfNeeded(controller.signal);
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) throw secretError('密钥核对失败，请重新识别。', 'data');
        output[index] = { ...candidates[index], fingerprint };
        completed++;
        if (candidates.length <= 100 || completed % 100 === 0 || completed === candidates.length) onProgress({ completed, total: candidates.length });
        abortIfNeeded(controller.signal);
        if (!pause && (completed % 100 === 0 || performance.now() - sliceStart >= 12)) {
            pause = Promise.resolve().then(yieldImpl).finally(() => { sliceStart = performance.now(); pause = null; });
        }
        if (pause) { await pause; abortIfNeeded(controller.signal); }
    };
    try {
        const settings = await read('settings');
        if (settings?.allowKeysExposure !== true) throw secretError('识别重复密钥需要酒馆开启 allowKeysExposure；当前仅能读取掩码，无法准确识别。', 'permission');
        try { snapshot = await read('read'); }
        catch (error) {
            abortIfNeeded(controller.signal);
            if (error?.type !== 'http' || ![404, 405].includes(error.status)) throw error;
            // Older servers may lack /read; bounded parallel reads keep their disk work manageable.
            let nextIndex = 0, failure;
            const worker = async () => {
                while (!controller.signal.aborted && nextIndex < candidates.length) {
                    const index = nextIndex++, entry = candidates[index];
                    let record;
                    try { record = await read('find', { key: entry.key, id: entry.id }); await digest(record, index); }
                    catch (error) {
                        if (!failure) { failure = error; controller.abort(error); }
                        return;
                    } finally { clearSecretValues(record); }
                }
            };
            await Promise.allSettled(Array.from({ length: Math.min(6, candidates.length) }, worker));
            if (failure) throw failure;
            abortIfNeeded(controller.signal);
            return output;
        }
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw secretError('服务器返回的密钥列表格式不兼容，请刷新酒馆后重试。', 'data');
        const indexes = new Map(), latest = [];
        // /read is authoritative: another device may have added, removed, renamed or selected keys.
        for (const key of services.keys()) {
            if (!Object.hasOwn(snapshot, key)) throw secretError('酒馆未能返回完整的密钥列表，请重试。', 'data');
            const records = snapshot[key];
            if (records === null) continue;
            if (!Array.isArray(records)) throw secretError('服务器返回的密钥列表格式不兼容，请刷新酒馆后重试。', 'data');
            const index = new Map();
            for (const record of records) {
                if (typeof record?.id !== 'string' || !record.id) throw secretError('密钥库含有无效 ID，请刷新后重新识别。', 'data');
                if (index.has(record.id)) throw secretError('密钥库含有重复 ID，请刷新后重新识别。', 'data');
                index.set(record.id, record);
            }
            if (index.size < 2) continue;
            indexes.set(key, index);
            for (const record of index.values()) latest.push(publicEntry({ key, id: record.id, label: record.label, active: record.active }));
        }
        if (latest.length !== candidates.length) onProgress({ completed: 0, total: latest.length });
        candidates = latest;
        output.length = candidates.length;
        abortIfNeeded(controller.signal);
        let nextIndex = 0, failure;
        const worker = async () => {
            while (!controller.signal.aborted && nextIndex < candidates.length) {
                const index = nextIndex++, entry = candidates[index];
                try { await digest(indexes.get(entry.key).get(entry.id), index); }
                catch (error) {
                    if (!failure) { failure = error; controller.abort(error); }
                    return;
                }
            }
        };
        await Promise.allSettled(Array.from({ length: Math.min(6, candidates.length) }, worker));
        if (failure) throw failure;
        abortIfNeeded(controller.signal);
        return output;
    } finally {
        clearSecretValues(snapshot);
        signal?.removeEventListener('abort', onAbort);
    }
}
