import * as openai from '../../../../openai.js';
import { secret_state, rotateSecret, SECRET_KEYS } from '../../../../secrets.js';
import * as script from '../../../../../script.js';
import { event_types } from './events.js';
import { CUSTOM_CREDENTIAL_KEYS } from './custom-connection.js';
import { createLegacyConnection, installLegacyTransport } from './legacy-connection.js';
import { yaml } from './libraries.js';
import { suppressCredentialHeaders } from './request-headers.js';
import { extension_settings } from '../../../../extensions.js';
import { linkLegacyState } from './legacy-state.js';

const { eventSource, saveSettingsDebounced } = script;

export const supportsNativeCustom = ['restoreCustomConnection', 'refreshCustomConnection', 'bindCustomCredential', 'connectChatCompletion']
    .every(name => typeof openai[name] === 'function');
export const customCredentialKeys = supportsNativeCustom ? CUSTOM_CREDENTIAL_KEYS : [SECRET_KEYS.CUSTOM];
export function supportsRequestSecretId() {
    const match = script.CLIENT_VERSION?.match(/SillyTavern:(\d+)\.(\d+)\.(\d+)/);
    return Boolean(match && (Number(match[1]) > 1 || Number(match[1]) === 1 && Number(match[2]) >= 18));
}

function refreshLegacyControls() {
    for (const [selector, field] of Object.values(openai.settingsToUpdate)) {
        // TauriTavern uses empty selectors for Custom settings without a DOM control.
        if (!field.startsWith('custom_') || typeof selector !== 'string' || !selector.trim()) continue;
        const node = document.querySelector(selector);
        if (node && 'value' in node) node.value = openai.oai_settings[field] ?? '';
    }
}
const legacy = supportsNativeCustom ? null : createLegacyConnection({
    settings: openai.oai_settings,
    getSecrets: () => secret_state,
    refresh: refreshLegacyControls,
    changed: reason => {
        saveSettingsDebounced();
        void eventSource.emit(event_types.CUSTOM_CONNECTION_CHANGED, { oldProviderId: null, newProviderId: null, reason });
    },
    supportsSecretId: supportsRequestSecretId,
    suppressAuth: headers => suppressCredentialHeaders(headers, yaml.parse),
});

export function refreshCustomConnection() {
    return supportsNativeCustom ? openai.refreshCustomConnection() : refreshLegacyControls();
}
export function restoreCustomConnection(snapshot, reason) {
    return supportsNativeCustom ? openai.restoreCustomConnection(snapshot, reason) : legacy.restore(snapshot, reason);
}
export async function bindCustomCredential(key, id) {
    if (supportsNativeCustom) return openai.bindCustomCredential(key, id);
    if (key !== SECRET_KEYS.CUSTOM) throw new Error('请为 Custom 连接选择 Custom 分类的密钥。');
    const previous = legacy.capture();
    const endpoint = new URL(openai.oai_settings.custom_url).toString().replace(/\/+$/, '');
    legacy.restore({ ...previous, credential: { mode: 'reference', key, id, endpoint } }, 'key selection');
    const release = legacy.pause();
    try {
        await rotateSecret(key, id);
        if (!secret_state[key]?.some(entry => entry.id === id && entry.active)) throw new Error('密钥未能切换，请重试。');
    } catch (error) {
        legacy.restore(previous, 'rollback');
        throw error;
    } finally { release(); }
}
export async function connectChatCompletion() {
    if (supportsNativeCustom) return openai.connectChatCompletion();
    const button = document.getElementById('api_button_openai');
    if (!button) throw new Error('未找到聊天补全连接按钮，请打开 API 设置。');
    button.click();
}
export function pauseLegacyRequests() { return legacy?.pause() ?? (() => {}); }
export function assertCustomCompatibility(snapshot) { return legacy ? legacy.assertSupported(snapshot) : snapshot; }

export function installHostCompatibility() {
    if (!legacy) return () => {};
    const unlink = linkLegacyState(openai.oai_settings, () => extension_settings);
    try { legacy.ensure(); } catch (error) { unlink(); throw error; }
    const removeTransport = installLegacyTransport({ target: window, connection: legacy, baseUrl: document.baseURI });
    const types = [event_types.SECRET_WRITTEN, event_types.SECRET_ROTATED].filter(Boolean);
    const select = key => { if (key === SECRET_KEYS.CUSTOM) legacy.selectActiveKey(); };
    for (const type of types) eventSource.on(type, select);
    const originalEmit = eventSource.emit;
    async function emitCompatible(type, ...args) {
        if (type !== event_types.CONNECTION_PROFILE_LOADED) return Reflect.apply(originalEmit, this, [type, ...args]);
        const release = legacy.pause();
        try { return await Reflect.apply(originalEmit, this, [type, ...args]); }
        finally { release(); }
    }
    eventSource.emit = emitCompatible;
    return () => {
        for (const type of types) eventSource.removeListener(type, select);
        removeTransport();
        if (eventSource.emit === emitCompatible) eventSource.emit = originalEmit;
        unlink();
    };
}
