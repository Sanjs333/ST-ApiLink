/** Old Node and TT apply custom headers after their default Authorization value. */
export function suppressCredentialHeaders(text, parse) {
    const parsed = text.trim() ? parse(text) : {};
    const mappings = Array.isArray(parsed) ? parsed : [parsed ?? {}];
    const headers = {};
    for (const mapping of mappings) {
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('附加请求头必须是 YAML 或 JSON 对象。');
        for (const [name, value] of Object.entries(mapping)) {
            if (/^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i.test(name)) continue;
            headers[name] = value;
        }
    }
    headers.Authorization = '';
    return JSON.stringify(headers);
}
