

/** Sources with a read-only model-list request in the native status endpoint. */
export const MODEL_DISCOVERY_SOURCES = Object.freeze([
    'custom', 'openai', 'openrouter', 'mistralai', 'cohere', 'chutes',
    'electronhub', 'nanogpt', 'deepseek', 'xai', 'aimlapi', 'pollinations',
    'groq', 'moonshot', 'fireworks', 'makersuite', 'siliconflow', 'workers_ai',
]);

// Azure's status handler also sends a completion probe; CometAPI is disabled.
// Neither is an appropriate endpoint for a model-list button.
export function supportsModelDiscovery(source) {
    return MODEL_DISCOVERY_SOURCES.includes(source);
}

export function mergeModelSuggestions(...lists) {
    const entries = new Map();
    for (const list of lists) {
        for (const item of list ?? []) {
            if (typeof item?.id !== 'string' || !item.id.trim()) continue;
            const previous = entries.get(item.id);
            entries.set(item.id, { ...previous, ...item,
                label: item.label || previous?.label || item.id,
                custom: Boolean(previous?.custom || item.custom) });
        }
    }
    return [...entries.values()];
}

function abortIfNeeded(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}

function responseMessage(payload) {
    const message = payload?.error?.message ?? payload?.message;
    return typeof message === 'string' && message.trim() ? '：' + message.trim().slice(0, 256) : '';
}

// The editor supplies unsaved fields and vault references; discovery never activates keys.
export async function fetchModelList(request, { headers, signal, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    abortIfNeeded(signal);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('模型拉取超时设置必须是正数。');
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
    const timer = setTimeout(() => cancel(new Error('拉取模型超时，请检查 API 地址和网络后重试。')), timeoutMs);
    try {
        // Race the entire request, including JSON parsing. Some transports do not honor abort.
        return await Promise.race([
            requestModels(request, { headers, signal: controller.signal, fetchImpl }), cancelled,
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

async function requestModels(request, { headers, signal, fetchImpl }) {
    abortIfNeeded(signal);
    if (!request || !supportsModelDiscovery(request.chat_completion_source)) {
        throw new Error('此来源暂不支持拉取模型，请手动填写模型 ID。');
    }
    const response = await fetchImpl('/api/backends/chat-completions/status', {
        method: 'POST', headers, signal, cache: 'no-cache', body: JSON.stringify(request),
    });
    abortIfNeeded(signal);
    let payload;
    try { payload = await response.json(); }
    catch (error) {
        abortIfNeeded(signal);
        if (error?.name === 'AbortError') throw error;
        if (!response.ok) throw new Error(`拉取模型失败（HTTP ${response.status}）。`);
        throw new Error('模型接口未返回有效的 JSON 数据。');
    }
    abortIfNeeded(signal);
    if (!response.ok) throw new Error(`拉取模型失败（HTTP ${response.status}）${responseMessage(payload)}`);
    if (payload?.error) throw new Error('拉取模型失败，请检查 API 地址和密钥' + responseMessage(payload));
    // Cohere returns `models`, while other native providers return `data`.
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload?.models;
    if (!Array.isArray(rows)) throw new Error('接口未返回模型列表。');
    const entries = new Map();
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const value = row.id ?? row.name;
        if (typeof value !== 'string' || !value.trim()) continue;
        const id = value.trim();
        if (entries.has(id)) continue;
        const label = row.label ?? row.name ?? row.display_name ?? row.displayName;
        entries.set(id, { id, label: typeof label === 'string' && label.trim() ? label.trim() : id });
    }
    if (!entries.size) throw new Error('接口没有返回可用的模型，请手动填写模型 ID。');
    return [...entries.values()];
}
