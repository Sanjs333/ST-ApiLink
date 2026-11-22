export class VertexModelError extends Error {
    constructor(code, message, status = 502) {
        super(message);
        this.name = 'VertexModelError';
        this.code = code;
        this.status = status;
    }
}

const abortedError = () => new DOMException('模型目录请求已取消。', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw signal.reason instanceof VertexModelError ? signal.reason : abortedError(); };

function modelEntry(row) {
    if (typeof row?.name !== 'string') return null;
    const id = row.name.match(/^publishers\/google\/models\/(gemini-[a-z0-9._@-]+)$/i)?.[1];
    if (!id || /(?:^|-)(?:embedding|live|tts|audio)(?:-|$)/i.test(id)) return null;
    const label = row.displayName ?? row.supportedActions?.deploy?.modelDisplayName;
    return { id, label: typeof label === 'string' && label.trim() ? label.trim() : id };
}

export async function fetchVertexModelList(request = {}, { authorize, fetchImpl = globalThis.fetch,
    signal, timeoutMs = 30_000, maxPages = 20 } = {}) {
    checkAbort(signal);
    if ((request.vertexai_auth_mode ?? 'full') !== 'full') {
        throw new VertexModelError('VERTEX_MODELS_FULL_REQUIRED', 'Google 模型目录需要 Full 服务账号认证；Express API 密钥不支持此目录接口。', 400);
    }
    if (typeof authorize !== 'function' || typeof fetchImpl !== 'function') {
        throw new VertexModelError('VERTEX_MODELS_CONFIGURATION', '模型目录服务尚未配置。', 500);
    }
    const region = request.vertexai_region || 'global';
    if (typeof region !== 'string' || !/^(?:global|[a-z]+(?:-[a-z0-9]+)+)$/.test(region)) {
        throw new VertexModelError('VERTEX_MODELS_REGION', 'Vertex 区域格式不正确。', 400);
    }
    if (request.secret_id != null && (typeof request.secret_id !== 'string' || !request.secret_id || request.secret_id.length > 256 || /[\u0000-\u001f\u007f]/.test(request.secret_id))) {
        throw new VertexModelError('VERTEX_MODELS_CREDENTIAL', '请选择有效的服务账号。', 400);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxPages) || maxPages <= 0) {
        throw new VertexModelError('VERTEX_MODELS_CONFIGURATION', '模型目录服务参数不正确。', 500);
    }
    const controller = new AbortController();
    let rejectCancellation;
    const cancelled = new Promise((_resolve, reject) => { rejectCancellation = reject; });
    const cancel = reason => {
        if (controller.signal.aborted) return;
        controller.abort(reason);
        rejectCancellation(reason);
    };
    const onAbort = () => cancel(abortedError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => cancel(new VertexModelError('VERTEX_MODELS_TIMEOUT', '读取 Google 模型目录超时，请检查网络后重试。', 504)), timeoutMs);
    const load = async () => {
        let auth;
        try { auth = await authorize(request, { signal: controller.signal }); }
        catch (error) {
            checkAbort(controller.signal);
            if (error instanceof VertexModelError) throw error;
            throw new VertexModelError('VERTEX_MODELS_AUTH', '服务账号认证失败，请检查服务账号是否有效。', 400);
        }
        checkAbort(controller.signal);
        if (typeof auth?.authorization !== 'string' || !/^Bearer [^\s\u0000-\u001f\u007f]+$/.test(auth.authorization)) {
            throw new VertexModelError('VERTEX_MODELS_AUTH', '服务账号未能取得有效的访问令牌。', 400);
        }
        const headers = { Authorization: auth.authorization, Accept: 'application/json' };
        if (typeof auth.projectId === 'string' && /^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(auth.projectId)) headers['x-goog-user-project'] = auth.projectId;
        const endpoint = `https://${region === 'global' ? '' : region + '-'}aiplatform.googleapis.com/v1beta1/publishers/google/models`;
        const entries = new Map(), seenTokens = new Set();
        let pageToken = '';
        for (let page = 0; page < maxPages; page++) {
            checkAbort(controller.signal);
            const url = new URL(endpoint);
            url.searchParams.set('pageSize', '100');
            url.searchParams.set('view', 'PUBLISHER_MODEL_VIEW_FULL');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            let response;
            try { response = await fetchImpl(url.toString(), { method: 'GET', headers, signal: controller.signal, redirect: 'error' }); }
            catch {
                checkAbort(controller.signal);
                throw new VertexModelError('VERTEX_MODELS_NETWORK', '无法连接 Google 模型目录，请检查网络后重试。');
            }
            checkAbort(controller.signal);
            if (!response.ok) {
                const message = response.status === 401 ? '服务账号访问令牌无效，请重新选择有效的服务账号。'
                    : response.status === 403 ? '服务账号无权读取 Google 模型目录，请检查 Vertex AI 和服务使用权限。'
                    : response.status === 429 ? 'Google 模型目录请求过于频繁，请稍后重试。'
                    : `Google 模型目录读取失败（HTTP ${response.status}）。`;
                throw new VertexModelError('VERTEX_MODELS_HTTP', message, response.status === 401 || response.status === 403 ? response.status : 502);
            }
            let payload;
            try { payload = await response.json(); }
            catch {
                checkAbort(controller.signal);
                throw new VertexModelError('VERTEX_MODELS_RESPONSE', 'Google 模型目录未返回有效的 JSON 数据。');
            }
            checkAbort(controller.signal);
            if (!Array.isArray(payload?.publisherModels)) {
                throw new VertexModelError('VERTEX_MODELS_RESPONSE', 'Google 模型目录返回格式不正确。');
            }
            for (const row of payload.publisherModels) {
                const entry = modelEntry(row);
                if (entry && !entries.has(entry.id)) entries.set(entry.id, entry);
            }
            pageToken = payload.nextPageToken ?? '';
            if (!pageToken) {
                if (!entries.size) throw new VertexModelError('VERTEX_MODELS_EMPTY', 'Google 模型目录没有返回可用的 Gemini 聊天模型。');
                return [...entries.values()];
            }
            if (typeof pageToken !== 'string' || pageToken.length > 8192 || seenTokens.has(pageToken)) {
                throw new VertexModelError('VERTEX_MODELS_PAGINATION', 'Google 模型目录分页异常，请稍后重试。');
            }
            seenTokens.add(pageToken);
        }
        throw new VertexModelError('VERTEX_MODELS_PAGINATION', 'Google 模型目录分页过多，请稍后重试。');
    };
    try { return await Promise.race([load(), cancelled]); }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
