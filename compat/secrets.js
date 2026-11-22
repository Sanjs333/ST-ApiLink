import * as nativeSecrets from '../../../../secrets.js';
import { eventSource, getRequestHeaders } from '../../../../../script.js';
import { event_types } from './events.js';
import { supportsNativeCustom, pauseLegacyRequests } from './host.js';
import { writeInactiveSecret } from './secret-write.js';

export { SECRET_KEYS, secret_state, readSecretState, rotateSecret, resolveSecretKey } from '../../../../secrets.js';
let writeQueue = Promise.resolve();

export async function writeSecret(key, value, label, options = {}) {
    if (supportsNativeCustom || options.activate !== false) return nativeSecrets.writeSecret(key, value, label, options);
    const action = () => writeInactiveSecret({
        key, value, label, getSecrets: () => nativeSecrets.secret_state,
        request: async (name, data) => {
            const response = await fetch('/api/secrets/' + name, {
                method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(data),
            });
            if (!response.ok) throw new Error('密钥操作失败，请重试。');
            return response;
        },
        refresh: nativeSecrets.readSecretState,
        notify: name => eventSource.emit(event_types.SECRET_WRITTEN, name),
        pause: pauseLegacyRequests,
    });
    const result = writeQueue.then(action, action);
    writeQueue = result.catch(() => {});
    return result;
}
