import { fetchVertexModelList, VertexModelError } from './vertex-models.mjs';

export const info = {
    id: 'st-apilink',
    name: 'API 链接管理模型目录',
    description: '通过已保存的 Vertex AI Full 服务账号只读刷新 Google 模型目录。',
};

export async function fetchVertexAccessToken(jwt, { signal, fetchImpl = globalThis.fetch } = {}) {
    const checkAbort = () => { if (signal?.aborted) throw new DOMException('服务账号认证已取消。', 'AbortError'); };
    checkAbort();
    let response;
    try {
        response = await fetchImpl('https://oauth2.googleapis.com/token', {
            method: 'POST', signal, redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
        });
    } catch {
        checkAbort();
        throw new VertexModelError('VERTEX_MODELS_AUTH', '无法连接 Google 认证服务，请检查网络后重试。', 400);
    }
    checkAbort();
    if (!response.ok) throw new VertexModelError('VERTEX_MODELS_AUTH', '服务账号认证失败，请检查账号是否有效以及服务器时间是否正确。', 400);
    let payload;
    try { payload = await response.json(); }
    catch {
        checkAbort();
        throw new VertexModelError('VERTEX_MODELS_AUTH', 'Google 认证服务未返回有效的访问令牌。', 400);
    }
    checkAbort();
    if (typeof payload?.access_token !== 'string' || !payload.access_token || /[\s\u0000-\u001f\u007f]/.test(payload.access_token)) {
        throw new VertexModelError('VERTEX_MODELS_AUTH', 'Google 认证服务未返回有效的访问令牌。', 400);
    }
    return payload.access_token;
}

export async function init(router) {
    const [{ readSecret, SECRET_KEYS }, { generateJWTToken }] = await Promise.all([
        import('../../../../../../src/endpoints/secrets.js'),
        import('../../../../../../src/endpoints/google.js'),
    ]);
    router.post('/models/vertexai', async (request, response) => {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        const onClose = () => { if (!response.writableEnded) onAbort(); };
        request.on('aborted', onAbort);
        response.on('close', onClose);
        try {
            if (!request.user?.directories) throw new VertexModelError('VERTEX_MODELS_USER', '请先登录酒馆后重试。', 401);
            const data = await fetchVertexModelList(request.body ?? {}, {
                signal: controller.signal,
                authorize: async (body, { signal }) => {
                    const value = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, body.secret_id);
                    if (!value) throw new VertexModelError('VERTEX_MODELS_CREDENTIAL', '请为 Vertex Full 模式选择已保存的服务账号。', 400);
                    let account;
                    try { account = JSON.parse(value); }
                    catch { throw new VertexModelError('VERTEX_MODELS_CREDENTIAL', '保存的服务账号 JSON 格式不正确。', 400); }
                    if (account?.type !== 'service_account' || typeof account.private_key !== 'string' || !account.private_key
                        || typeof account.client_email !== 'string' || !account.client_email || typeof account.project_id !== 'string' || !account.project_id) {
                        throw new VertexModelError('VERTEX_MODELS_CREDENTIAL', '保存的服务账号缺少有效的类型、私钥、邮箱或项目 ID。', 400);
                    }
                    const jwt = await generateJWTToken(account);
                    const token = await fetchVertexAccessToken(jwt, { signal });
                    return { authorization: `Bearer ${token}`, projectId: account.project_id };
                },
            });
            if (!controller.signal.aborted) response.json({ data, source: 'vertexai', catalog: 'google-model-garden' });
        } catch (error) {
            if (controller.signal.aborted || response.headersSent) return;
            const known = error instanceof VertexModelError;
            response.status(known ? error.status : 500).json({ error: {
                code: known ? error.code : 'VERTEX_MODELS_SERVER',
                message: known ? error.message : '模型目录服务暂时不可用，请稍后重试。',
            } });
        } finally {
            request.removeListener('aborted', onAbort);
            response.removeListener('close', onClose);
        }
    });
}
