

const privateKeyError = () => new Error('private_key 必须是有效的 PKCS#8 私钥 PEM（BEGIN PRIVATE KEY），请粘贴服务账号 JSON 中的完整私钥。');

function readDer(bytes, offset, limit = bytes.length) {
    if (offset + 2 > limit) throw privateKeyError();
    const tag = bytes[offset++];
    let length = bytes[offset++];
    if (length & 0x80) {
        const count = length & 0x7f;
        if (!count || count > 4 || offset + count > limit || bytes[offset] === 0) throw privateKeyError();
        length = 0;
        for (let index = 0; index < count; index++) length = length * 256 + bytes[offset++];
        if (length < 128) throw privateKeyError();
    }
    const end = offset + length;
    if (end > limit) throw privateKeyError();
    return { tag, start: offset, end, length };
}

function validatePrivateKey(value) {
    const match = value.trim().match(/^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/]+={0,2}(?:\r?\n[A-Za-z0-9+/]+={0,2})*)\r?\n-----END PRIVATE KEY-----$/);
    if (!match) throw privateKeyError();
    const encoded = match[1].replace(/\r?\n/g, '');
    if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw privateKeyError();
    let bytes;
    try {
        const decoded = atob(encoded);
        if (btoa(decoded) !== encoded) throw privateKeyError();
        bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    } catch { throw privateKeyError(); }
    const outer = readDer(bytes, 0);
    if (outer.tag !== 0x30 || outer.end !== bytes.length) throw privateKeyError();
    const version = readDer(bytes, outer.start, outer.end);
    if (version.tag !== 0x02 || version.length !== 1 || bytes[version.start] > 1) throw privateKeyError();
    const algorithm = readDer(bytes, version.end, outer.end);
    if (algorithm.tag !== 0x30) throw privateKeyError();
    const identifier = readDer(bytes, algorithm.start, algorithm.end);
    if (identifier.tag !== 0x06 || !identifier.length || bytes[identifier.end - 1] & 0x80) throw privateKeyError();
    for (let offset = identifier.end; offset < algorithm.end;) offset = readDer(bytes, offset, algorithm.end).end;
    const key = readDer(bytes, algorithm.end, outer.end);
    if (key.tag !== 0x04 || key.length < 16) throw privateKeyError();
    for (let offset = key.end; offset < outer.end;) {
        const optional = readDer(bytes, offset, outer.end);
        if (![0xa0, 0x81, 0xa1].includes(optional.tag)) throw privateKeyError();
        offset = optional.end;
    }
}

export function validateServiceAccountJson(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请输入服务账号 JSON。');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('服务账号 JSON 格式无效，请检查引号、逗号和换行。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('服务账号 JSON 必须是一个对象。');
    if (parsed.type !== 'service_account') throw new Error('type 必须为 service_account，请使用 Google 下载的服务账号 JSON。');
    for (const field of ['project_id', 'private_key', 'client_email', 'client_id']) {
        if (typeof parsed[field] !== 'string' || !parsed[field].trim()) throw new Error(`服务账号 JSON 缺少有效的 ${field}，该字段必须为非空字符串。`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.client_email)) throw new Error('client_email 必须是有效的邮箱地址。');
    validatePrivateKey(parsed.private_key);
    return parsed;
}
