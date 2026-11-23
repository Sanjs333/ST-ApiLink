import { secret_state } from '../../../../secrets.js';
import { getRequestHeaders } from '../../../../../script.js';
import { oai_settings, proxies } from '../../../../openai.js';
import { yaml } from '../compat/libraries.js';
import { getPresetManager } from '../../../../preset-manager.js';
import { reasoning_templates } from '../../../../reasoning.js';
import { normalizeCustomEndpoint } from '../compat/custom-connection.js';
import { assertCustomCompatibility, supportsRequestSecretId } from '../compat/host.js';
import { Popup } from '../../../../popup.js';
import { CUSTOM_MODEL_SOURCES } from '../models/custom.js';
import { PROFILE_FIELD, profileSource, profileEditorFields, resolveProfileProxy, editedCustomSnapshot, approvedCredential, normalizeMetadata, keyBinding } from './state.js';
import { sourceKey } from './runtime.js';
import { secretName } from '../secrets/manager.js';
import { element, button, dialog, showError, themedPopupOptions } from '../ui/common.js';
import { fetchModelList, mergeModelSuggestions, supportsModelDiscovery } from '../models/discovery.js';
import { installModelPicker } from '../models/picker.js';
import { manageProxyPresets } from './proxies.js';
import { createParameterPresetControls } from '../parameters/editor.js';
import { installSearchableSelects } from '../ui/select.js';

export const sourceLabel = source => CUSTOM_MODEL_SOURCES[source]?.label ?? ({ custom: 'Custom 兼容接口', azure_openai: 'Azure OpenAI' }[source] ?? source ?? '未记录来源');

function field(label, control, note = '', important = false) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName) && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
    return element('label', { class: 'cw-field' }, [
        element('div', { class: 'cw-field-heading' }, [element('span', { text: label }),
            element('span', { class: 'cw-field-note cw-note' + (important ? ' cw-important-note' : ''), text: note })]), control,
    ]);
}

function validateParameters(fields) {
    for (const name of ['custom_include_headers', 'custom_include_body']) {
        if (!fields[name]?.trim()) continue;
        let parsed;
        try { parsed = yaml.parse(fields[name]); } catch { throw new Error((name.endsWith('headers') ? '附加请求头' : '附加请求体') + '格式不正确，请使用 YAML 或 JSON。'); }
        const mappings = Array.isArray(parsed) ? parsed : [parsed];
        if (mappings.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('附加参数需要键值对，例如 stream_options: {}。');
        if (name === 'custom_include_headers' && mappings.some(item => Object.keys(item).some(key => /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i.test(key)))) throw new Error('认证请求头请通过密钥选择设置，附加请求头不能覆盖它。');
    }
    if (fields.custom_exclude_body?.trim()) {
        try { yaml.parse(fields.custom_exclude_body); } catch { throw new Error('排除字段格式不正确，请使用 YAML 列表。'); }
    }
}

/** Start a complete connection form without borrowing the live connection or its generation preset. */
export function createProfile(options) {
    const fields = Object.fromEntries(['custom_url', 'custom_model', 'custom_include_headers', 'custom_include_body', 'custom_exclude_body', 'custom_prompt_post_processing'].map(key => [key, '']));
    return editProfile({ name: '', mode: 'cc', api: 'custom', model: '',
        exclude: ['preset', 'stop-strings', 'start-reply-with', 'reasoning-template', 'regex-preset'],
        [PROFILE_FIELD]: { version: 1, source: 'custom', model: '', fields, proxy: { mode: 'none' }, credential: null },
    }, { ...options, creating: true, onDelete: null });
}

export async function editProfile(profile, { runtime, vault, models, parameterPresets = null, creating = false, onDelete = null, onError = showError }) {
    let created = null;
    const original = structuredClone(profile);
    const root = element('div', { class: 'cw-dialog cw-editor cw-profile-editor' });
    const controls = element('div', { class: 'cw-fields' });
    const connectionGroup = runtime.groupFor?.(profile);
    if (connectionGroup) controls.append(element('div', {
        class: 'cw-note cw-group-editor-note',
        text: `连接组「${connectionGroup.name}」按地址归类；此方案的密钥、模型、API 来源、代理和附加参数独立保存。更换到其他地址时，此方案会移出原组。`,
    }));
    const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
    const modelStatus = element('span', { class: 'cw-model-status cw-note', role: 'status' });
    const name = element('input', { class: 'text_pole', value: profile.name, 'aria-label': '方案名称' });
    const source = element('select', { class: 'text_pole' }, [new Option('Custom 兼容接口', 'custom'), ...Object.entries(CUSTOM_MODEL_SOURCES).map(([key, config]) => new Option(config.label, key)), new Option('Azure OpenAI', 'azure_openai')]);
    if (![...source.options].some(option => option.value === profileSource(profile))) source.add(new Option(sourceLabel(profileSource(profile)), profileSource(profile)));
    source.value = profileSource(profile);
    const model = element('input', { class: 'text_pole', value: profile[PROFILE_FIELD]?.model ?? profile['custom-connection']?.settings?.custom_model ?? profile.model ?? '', autocomplete: 'off', placeholder: '模型 ID', 'aria-label': '模型 ID' });
    const preset = creating ? {} : getPresetManager('openai')?.getCompletionPresetByName(profile.preset) ?? {};
    const initialFields = profileEditorFields(profile, preset);
    const endpoint = element('input', { class: 'text_pole', value: initialFields.custom_url ?? '', placeholder: 'https://api.example.com/v1', autocomplete: 'off' });
    const proxy = element('select', { class: 'text_pole', 'aria-label': '反向代理（可选）' });
    const savedProxy = profile[PROFILE_FIELD]?.proxy;
    const proxyValue = savedProxy?.mode === 'preset' ? 'preset:' + savedProxy.name : savedProxy?.mode ?? (profile.proxy === 'None' ? 'none' : profile.proxy ? 'preset:' + profile.proxy : 'inherit');
    function refreshProxyOptions(value = proxy.value || proxyValue) {
        proxy.replaceChildren(new Option('不使用反向代理', 'none'), new Option('继承当前代理', 'inherit'),
            ...proxies.filter(preset => preset.name !== 'None' || preset.url?.trim() || preset.password?.trim()).map(preset =>
                new Option(preset.name?.trim() ? preset.name : preset.url?.trim() || preset.password?.trim() ? '未命名代理（请先设置名称）' : '不使用反向代理', 'preset:' + preset.name)));
        if (![...proxy.options].some(option => option.value === value)) proxy.add(new Option('已失效：' + value.slice(7), value));
        proxy.value = value;
    }
    refreshProxyOptions(proxyValue);
    let modelController = null, modelRevision = 0, modelContext = '';
    const modelApprovals = new Set();
    let modelPicker = null;
    let deleting = false, saving = false, detachingBinding = false;
    function bindingSelect(key, unbound, names) {
        const selected = !(Array.isArray(original.exclude) && original.exclude.includes(key)) && typeof original[key] === 'string' ? original[key] : '';
        const available = [...new Set(Array.isArray(names) ? names.filter(name => typeof name === 'string' && name) : [])];
        const select = element('select', { class: 'text_pole' }, [new Option(unbound, ''), ...available.map(name => new Option(name, name))]);
        if (selected && !available.includes(selected)) select.add(new Option('已失效：' + selected, selected));
        select.value = selected;
        return select;
    }
    const presetBinding = bindingSelect('preset', '不绑定预设', getPresetManager('openai')?.getAllPresets?.() ?? []);
    const reasoningBinding = bindingSelect('reasoning-template', '不绑定推理模板', reasoning_templates.map(template => template.name));
    const bindingButtons = [];
    function refreshBindingButtons() {
        for (const [key, select, detach] of bindingButtons) {
            detach.disabled = saving || deleting || detachingBinding
                || !(select.value || !creating && Object.hasOwn(original, key));
        }
    }
    async function clearBinding(key, select) {
        if (saving || deleting || detachingBinding) return;
        const clearDraft = () => {
            select.value = '';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (creating || !Object.hasOwn(original, key)) {
            clearDraft();
            refreshBindingButtons();
            return;
        }
        detachingBinding = true;
        const states = [...new Set([...root.querySelectorAll('input, select, textarea, button'),
            ...(root.closest('dialog')?.querySelectorAll('.popup-controls button') ?? [])])].map(control => [control, control.disabled]);
        for (const [control] of states) control.disabled = true;
        try {
            if (key === 'reasoning-template') await runtime.detachLegacyReasoning(profile);
            else await runtime.detachOptionalBinding(profile, key);
            delete original[key];
            original.exclude = [...new Set([...(Array.isArray(original.exclude) ? original.exclude : []), key])];
            clearDraft();
            status.textContent = key === 'preset' ? '已解除预设绑定。' : '已解除推理模板绑定。';
        } catch (error) { status.textContent = error.message; onError(error); }
        finally {
            for (const [control, disabled] of states) control.disabled = disabled;
            detachingBinding = false;
            refreshModelLoading();
            refreshBindingButtons();
        }
    }
    function bindingField(key, label, select, note, actionLabel) {
        select.setAttribute('aria-label', label);
        const detach = button(actionLabel, () => clearBinding(key, select), 'cw-icon-button');
        detach.replaceChildren(element('i', { class: 'fa-solid fa-link-slash', 'aria-hidden': 'true' }));
        bindingButtons.push([key, select, detach]);
        select.addEventListener('change', refreshBindingButtons);
        return field(label, element('div', { class: 'cw-binding-input' }, [select, detach]), note);
    }
    const optionalBindings = element('div', { class: 'cw-optional-bindings cw-fields' }, [
        bindingField('preset', '聊天补全预设', presetBinding, '加载此连接方案时，同时切换所选预设。', '解除预设绑定'),
        bindingField('reasoning-template', '推理模板', reasoningBinding, '加载此连接方案时，同时切换所选推理模板。', '解除推理模板绑定'),
    ]);

    let binding = keyBinding(profile) ?? (profile['secret-id'] ? { key: sourceKey(profileSource(profile), initialFields), id: profile['secret-id'] } : null);
    let approvalRoot = profile['custom-connection']?.credential?.endpoint ?? endpoint.value;
    let explicitlyNoKey = profile['custom-connection']?.credential?.mode === 'none' || profile['custom-connection']?.credential?.mode === 'legacy-custom' && profile['custom-connection'].credential.id === null;
    let keyBeforeNone = null;
    const keyText = element('span', { class: 'cw-field-note cw-note' });
    const keyRow = element('div', { class: 'cw-field cw-key-field' });
    function toggleNoKey() {
        const policy = source.value === 'custom' ? original['custom-connection']?.auth : null;
        if (source.value !== 'custom' || policy?.required || policy?.mode === 'none') throw new Error('此服务的密钥要求不能通过免密按钮切换。');
        let message = '此方案不发送密钥';
        if (explicitlyNoKey) {
            explicitlyNoKey = false;
            binding = null;
            message = '已取消不使用密钥，请为此方案选择密钥';
            let sameRoot = false;
            try { sameRoot = normalizeCustomEndpoint(endpoint.value) === normalizeCustomEndpoint(keyBeforeNone?.root); } catch { /* Reapproval is required for a changed root. */ }
            if (keyBeforeNone?.source === source.value && sameRoot) {
                const previous = keyBeforeNone.binding;
                if (previous && secret_state[previous.key]?.some(entry => entry.id === previous.id)) {
                    binding = structuredClone(previous); approvalRoot = keyBeforeNone.root;
                    message = '已取消不使用密钥，恢复此方案之前选择的密钥';
                } else if (previous) message = '之前的密钥已删除，已取消免密，请重新选择密钥';
            } else if (keyBeforeNone) message = '来源或 API 地址已变更，已取消免密，请重新选择密钥';
            keyBeforeNone = null;
        } else {
            keyBeforeNone = { binding: binding && structuredClone(binding), root: approvalRoot, source: source.value };
            binding = null; explicitlyNoKey = true;
        }
        renderKey();
        keyText.textContent = message;
        keyText.title = message;
        return { enabled: explicitlyNoKey, restored: Boolean(binding), message };
    }
    const noKeyButton = button('不使用密钥', toggleNoKey);
    function renderKey() {
        const policy = source.value === 'custom' ? original['custom-connection']?.auth : null;
        if (policy?.mode === 'none') { binding = null; explicitlyNoKey = true; }
        const entry = binding && secret_state[binding.key]?.find(item => item.id === binding.id);
        keyText.textContent = binding ? entry ? `${secretName(binding.key)}：${entry.label || '未命名密钥'}` : '保存的密钥已删除，请重新选择' : explicitlyNoKey && source.value === 'custom' ? '不发送密钥' : source.value === 'custom' ? '请选择密钥，或明确选择不使用密钥' : creating ? '未绑定密钥：沿用此来源当前选中的密钥' : '沿用此来源当前选中的密钥';
        keyText.title = keyText.textContent;
        keyText.classList.toggle('cw-important-note', Boolean(binding && !entry || !binding && !explicitlyNoKey && source.value === 'custom'));
        noKeyButton.hidden = source.value !== 'custom';
        noKeyButton.disabled = Boolean(policy?.required || policy?.mode === 'none');
        noKeyButton.classList.toggle('active', Boolean(explicitlyNoKey));
        noKeyButton.setAttribute('aria-pressed', String(Boolean(explicitlyNoKey)));
        noKeyButton.title = policy?.mode === 'none' ? '此服务不使用密钥' : explicitlyNoKey ? '取消不使用密钥' : '不使用密钥';
        noKeyButton.setAttribute('aria-label', noKeyButton.title);
        refreshModelContext();
    }

    const vertexMode = element('select', { class: 'text_pole' }, [new Option('Express：API 密钥', 'express'), new Option('Full：服务账号', 'full')]);
    vertexMode.value = initialFields.vertexai_auth_mode ?? 'express';
    const region = element('input', { class: 'text_pole', value: initialFields.vertexai_region ?? 'us-central1' });
    const project = element('input', { class: 'text_pole', value: initialFields.vertexai_express_project_id ?? '' });
    const vertexFields = element('div', { class: 'cw-fields' }, [field('Vertex 认证方式', vertexMode), field('区域', region), field('项目 ID', project)]);
    const azureFields = {};
    const azureContainer = element('div', { class: 'cw-fields' });
    for (const [key, label] of [['azure_base_url', 'Azure API 地址'], ['azure_deployment_name', '部署名称'], ['azure_api_version', 'API 版本']]) {
        azureFields[key] = element('input', { class: 'text_pole', value: initialFields[key] ?? '' });
        azureContainer.append(field(label, azureFields[key]));
    }
    const discoveryFields = {
        workers_ai: { workers_ai_account_id: element('input', { class: 'text_pole', value: initialFields.workers_ai_account_id ?? '', autocomplete: 'off' }) },
        siliconflow: { siliconflow_endpoint: element('select', { class: 'text_pole' }, [new Option('国际站（siliconflow.com）', 'global'), new Option('中国站（siliconflow.cn）', 'cn')]) },
        pollinations: { pollinations_endpoint: element('select', { class: 'text_pole' }, [new Option('使用 API 密钥', 'authenticated'), new Option('匿名免密', 'anonymous')]) },
    };
    discoveryFields.siliconflow.siliconflow_endpoint.value = initialFields.siliconflow_endpoint ?? 'global';
    discoveryFields.pollinations.pollinations_endpoint.value = initialFields.pollinations_endpoint ?? 'authenticated';
    const discoveryContainers = Object.fromEntries(Object.entries(discoveryFields).map(([key, fields]) => [key,
        element('div', { class: 'cw-fields' }, Object.entries(fields).map(([name, input]) =>
            field(name === 'workers_ai_account_id' ? 'Cloudflare 账号 ID' : '服务端点', input)))]));
    const customParameters = Object.fromEntries(['custom_include_headers', 'custom_include_body', 'custom_exclude_body'].map(key => [key, String(initialFields[key] ?? '')]));
    const customContainer = element('div', { class: 'cw-fields' });
    const parameterControls = parameterPresets ? createParameterPresetControls({
        store: parameterPresets,
        readFields: () => ({ ...customParameters }),
        writeFields: fields => {
            for (const key of Object.keys(customParameters)) customParameters[key] = fields[key] ?? '';
            refreshModelContext();
        }, onError,
    }) : null;
    if (parameterControls) customContainer.prepend(parameterControls.root);
    const endpointField = field('API 地址', endpoint);
    keyRow.append(element('div', { class: 'cw-field-heading' }, [element('span', { text: '密钥' }), keyText]),
        element('div', { class: 'cw-field-inline' }, [button('选择密钥', async () => {
        try {
            const allowedKeys = source.value === 'custom' ? vault.customKeys : [sourceKey(source.value, { vertexai_auth_mode: vertexMode.value })].filter(Boolean);
            if (!allowedKeys.length) throw new Error('此来源请使用原生密钥设置。');
            const canToggleNone = source.value === 'custom' && !original['custom-connection']?.auth?.required && original['custom-connection']?.auth?.mode !== 'none';
            await vault.open({ title: '为此方案选择密钥', allowedKeys, defaultKey: binding?.key ?? sourceKey(source.value, { vertexai_auth_mode: vertexMode.value }) ?? allowedKeys[0],
                onRebind: (from, to) => {
                    if (binding?.key === from.key && binding.id === from.id) binding = { key: to.key, id: to.id };
                    if (keyBeforeNone?.binding?.key === from.key && keyBeforeNone.binding.id === from.id) keyBeforeNone.binding = { key: to.key, id: to.id };
                    renderKey();
                },
                onNone: canToggleNone ? toggleNoKey : null, isNone: () => Boolean(explicitlyNoKey),
                isChosen: entry => binding?.key === entry.key && binding.id === entry.id, onChoose: entry => {
                    binding = { key: entry.key, id: entry.id }; approvalRoot = endpoint.value; explicitlyNoKey = false; keyBeforeNone = null; renderKey();
                } });
        } catch (error) { onError(error); }
    }), noKeyButton]));

    const proxyField = field('反向代理（可选）', element('div', { class: 'cw-proxy-input' }, [proxy,
        button('编辑反向代理', async () => {
            try {
                await manageProxyPresets({ onError, onChange: selectedName => {
                    refreshProxyOptions(selectedName === null ? proxy.value : 'preset:' + selectedName);
                    refreshProxyNote(); refreshModelContext();
                } });
                refreshProxyOptions(); refreshProxyNote(); refreshModelContext();
            } catch (error) { setProxyNote(error.message, true); }
        }),
    ]));
    const proxyNote = proxyField.querySelector('.cw-field-note');
    function setProxyNote(text, important = false) {
        proxyNote.textContent = text;
        proxyNote.classList.toggle('cw-important-note', important);
    }
    function refreshProxyNote() {
        try {
            const selection = resolveProfileProxy(proxy.value, proxies);
            setProxyNote(source.value === 'custom' ? 'Custom 直接使用上方 API 地址，通常无需反向代理。'
                : selection.mode === 'none' ? '直接使用服务商默认 API 地址。' : '用于替换服务商的默认 API 地址。');
        } catch (error) { setProxyNote(error.message, true); }
    }
    proxy.addEventListener('change', refreshProxyNote);

    function setModelStatus(text, important = false) {
        modelStatus.textContent = text;
        modelStatus.classList.toggle('cw-important-note', important);
    }

    function modelContextValue() {
        return JSON.stringify([source.value, endpoint.value, binding, explicitlyNoKey, proxy.value,
            Object.values(azureFields).map(input => input.value), vertexMode.value, region.value, project.value,
            Object.values(discoveryFields).flatMap(fields => Object.values(fields).map(input => input.value)),
            customParameters.custom_include_headers]);
    }
    function availableModelEntries(fetched = []) {
        const selectedSource = source.value;
        const selector = CUSTOM_MODEL_SOURCES[selectedSource]?.selector
            ?? ({ custom: '#model_custom_select', azure_openai: '#azure_openai_model' }[selectedSource]);
        let useNative = selectedSource !== 'custom';
        if (selectedSource === 'custom' && oai_settings.chat_completion_source === 'custom') {
            try { useNative = normalizeCustomEndpoint(endpoint.value) === normalizeCustomEndpoint(oai_settings.custom_url); }
            catch { useNative = false; }
        }
        const native = useNative && selector ? [...(root.ownerDocument.querySelector(selector)?.options ?? [])]
            .filter(option => option.value && !option.disabled && !option.hidden && !option.parentElement?.disabled && !option.parentElement?.hidden)
            .map(option => ({ id: option.value, label: option.textContent.trim() || option.value })) : [];
        const saved = (runtime.profiles?.() ?? []).filter(entry => {
            if (profileSource(entry) !== selectedSource) return false;
            if (selectedSource !== 'custom') return true;
            const fields = profileEditorFields(entry);
            try { return normalizeCustomEndpoint(fields.custom_url) === normalizeCustomEndpoint(endpoint.value); }
            catch { return false; }
        }).map(entry => ({ id: entry[PROFILE_FIELD]?.model ?? entry['custom-connection']?.settings?.custom_model ?? entry.model }));
        const additions = Object.hasOwn(CUSTOM_MODEL_SOURCES, selectedSource)
            ? (models?.list(selectedSource) ?? []).map(entry => ({ ...entry, custom: true })) : [];
        return mergeModelSuggestions(native, saved, fetched, additions);
    }
    function refreshModelSuggestions({ open = false, fetched = [] } = {}) {
        const entries = availableModelEntries(fetched);
        modelPicker?.setItems(entries, { open });
        return entries;
    }
    function refreshModelContext() {
        const next = modelContextValue();
        if (next === modelContext) return;
        modelContext = next; modelRevision++;
        setModelStatus(modelController ? '连接设置已变更，请重新拉取模型。' : '');
        modelController?.abort();
        refreshModelSuggestions();
        refreshModelLoading();
    }
    const canFetchModels = () => supportsModelDiscovery(source.value);
    const fetchModels = button('拉取模型', async () => {
        if (modelController && !modelController.signal.aborted) return;
        refreshModelContext();
        if (!canFetchModels()) {
            model.focus({ preventScroll: true });
            const entries = refreshModelSuggestions({ open: true });
            setModelStatus(entries.length ? `已刷新 ${entries.length} 个内置或已保存模型；可选择，也可填写模型 ID。`
                : '此来源没有可用的内置或已保存模型，请填写模型 ID。');
            return;
        }
        const revision = modelRevision;
        modelController = new AbortController();
        const controller = modelController;
        refreshModelSuggestions();
        refreshModelLoading();
        try {
            const selectedSource = source.value;
            if (binding && !secret_state[binding.key]?.some(entry => entry.id === binding.id)) throw new Error('选择的密钥已删除，请重新选择。');
            if (binding && !supportsRequestSecretId() && !secret_state[binding.key]?.some(entry => entry.id === binding.id && entry.active)) {
                throw new Error('当前酒馆版本只能用已激活的密钥拉取模型，请先切换到此密钥后重试。');
            }
            const request = { chat_completion_source: selectedSource, reverse_proxy: '', proxy_password: '' };
            if (selectedSource === 'custom') {
                const apiRoot = normalizeCustomEndpoint(endpoint.value.trim());
                if (!binding && !explicitlyNoKey) throw new Error('请选择密钥，或点击“不使用密钥”。');
                const headers = customParameters.custom_include_headers;
                validateParameters({ custom_include_headers: headers });
                const credential = binding ? approvedCredential(binding.key, binding.id, apiRoot) : { mode: 'none' };
                const previous = original['custom-connection']?.credential;
                const approved = previous?.mode === 'reference' && previous.key === binding?.key && previous.id === binding?.id && previous.endpoint === apiRoot;
                const approvalId = JSON.stringify(credential);
                if (binding && apiRoot.startsWith('http:') && !approved && !modelApprovals.has(approvalId)) {
                    if (!await Popup.show.confirm('确认向此 HTTP 地址发送密钥？', '请确认这是你信任的本机或局域网 API 地址。', themedPopupOptions())) return;
                    if (revision !== modelRevision || controller.signal.aborted) return;
                    modelApprovals.add(approvalId);
                }
                const auth = original['custom-connection']?.auth ?? { mode: 'bearer', required: false };
                Object.assign(request, { custom_url: apiRoot, custom_include_headers: headers,
                    custom_auth: { version: 1, auth, credential } });
            } else {
                if (binding && binding.key !== sourceKey(selectedSource)) throw new Error('密钥服务与 API 来源不同，请重新选择。');
                if (binding) request.secret_id = binding.id;
                if (selectedSource === 'azure_openai') Object.assign(request, Object.fromEntries(Object.entries(azureFields).map(([key, input]) => [key, input.value.trim()])));
                Object.assign(request, Object.fromEntries(Object.entries(discoveryFields[selectedSource] ?? {}).map(([key, input]) => [key, input.value.trim()])));
                if (selectedSource === 'workers_ai' && !request.workers_ai_account_id) throw new Error('请填写 Cloudflare 账号 ID。');
                if (proxy.value !== 'none') {
                    const selectedProxy = resolveProfileProxy(proxy.value, proxies);
                    if (selectedProxy.mode === 'preset') {
                        const preset = proxies.find(entry => entry.name === selectedProxy.name);
                        Object.assign(request, { reverse_proxy: preset.url || '', proxy_password: preset.password || '' });
                    } else if (selectedProxy.mode === 'inherit') Object.assign(request, { reverse_proxy: oai_settings.reverse_proxy || '', proxy_password: oai_settings.proxy_password || '' });
                }
            }
            setModelStatus('正在拉取模型…');
            const entries = await fetchModelList(request, { headers: getRequestHeaders(), signal: controller.signal });
            if (revision !== modelRevision || controller.signal.aborted) return;
            model.focus({ preventScroll: true });
            refreshModelSuggestions({ open: true, fetched: entries });
            setModelStatus(`已拉取 ${entries.length} 个模型。`);
        } catch (error) {
            if (controller.signal.aborted || revision !== modelRevision) return;
            const message = error?.message || '请求失败，请重试。';
            const reason = /Failed to fetch|NetworkError|Load failed/i.test(message)
                ? '网络请求失败，请检查 API 地址和网络后重试。' : message;
            setModelStatus(reason.startsWith('拉取模型') ? reason : '拉取模型失败：' + reason, true);
        } finally {
            if (modelController === controller) modelController = null;
            refreshModelLoading();
        }
    });
    const modelField = element('div', { class: 'cw-field' }, [
        element('div', { class: 'cw-model-heading' }, [element('span', { text: '模型' }), modelStatus]),
        element('div', { class: 'cw-model-input' }, [model, fetchModels])]);
    modelPicker = installModelPicker(model, { groupButtonStyle: 'toolbar' });

    function refreshModelLoading() {
        const loading = Boolean(modelController && !modelController.signal.aborted);
        fetchModels.disabled = saving || deleting || detachingBinding || loading;
        fetchModels.setAttribute('aria-busy', String(loading));
        fetchModels.querySelector('i')?.classList.toggle('fa-spin', loading);
        fetchModels.title = canFetchModels() ? '拉取模型' : '刷新内置和已保存模型';
        fetchModels.setAttribute('aria-label', fetchModels.title);
    }

    function refreshSource() {
        customContainer.hidden = source.value !== 'custom';
        endpointField.hidden = source.value !== 'custom';
        vertexFields.hidden = source.value !== 'vertexai';
        azureContainer.hidden = source.value !== 'azure_openai';
        for (const [key, container] of Object.entries(discoveryContainers)) container.hidden = source.value !== key;
        refreshModelLoading();
        renderKey();
        refreshModelSuggestions();
        if (!canFetchModels()) setModelStatus('从内置或已保存模型中选择，也可填写模型 ID。');
        refreshProxyNote();
    }
    source.addEventListener('change', () => { binding = null; explicitlyNoKey = false; keyBeforeNone = null; refreshSource(); });
    endpoint.addEventListener('input', () => {
        if (!binding) return;
        let same = false;
        try { same = normalizeCustomEndpoint(endpoint.value) === normalizeCustomEndpoint(approvalRoot); } catch { /* An incomplete address cannot retain approval. */ }
        if (!same) { binding = null; explicitlyNoKey = false; renderKey(); }
    });
    vertexMode.addEventListener('change', () => {
        if (binding && binding.key !== sourceKey('vertexai', { vertexai_auth_mode: vertexMode.value })) binding = null;
        renderKey();
    });
    controls.addEventListener('input', event => { if (event.target !== model) refreshModelContext(); });
    controls.addEventListener('change', event => { if (event.target !== model) refreshModelContext(); });
    root.addEventListener('cw-action-settled', () => { refreshModelLoading(); refreshBindingButtons(); });

    const save = button('保存', async () => {
        if (deleting || detachingBinding) return;
        saving = true;
        remove.disabled = true;
        const controlStates = [...controls.querySelectorAll('input, select, textarea, button')].map(control => [control, control.disabled]);
        for (const [control] of controlStates) control.disabled = true;
        try {
            const inputState = () => JSON.stringify([name.value, model.value, modelContextValue(), presetBinding.value, reasoningBinding.value,
                Object.values(customParameters)]);
            const savingState = inputState();
            const updated = structuredClone(original);
            const selectedSource = source.value;
            updated.name = name.value;
            updated.api = selectedSource === 'makersuite' ? 'google' : selectedSource;
            updated.mode = 'cc';
            updated.model = model.value.trim();
            updated.exclude = Array.isArray(updated.exclude) ? updated.exclude : [];
            for (const [key, select] of [['preset', presetBinding], ['reasoning-template', reasoningBinding]]) {
                updated.exclude = updated.exclude.filter(value => value !== key);
                if (select.value) updated[key] = select.value;
                else { delete updated[key]; updated.exclude.push(key); }
            }
            if (creating && (!updated.model || updated.model.length > 512 || /[\u0000-\u001f\u007f]/.test(updated.model))) throw new Error('请输入有效的模型 ID（最多 512 个字符）。');
            let selectedProxy;
            try { selectedProxy = resolveProfileProxy(proxy.value, proxies); }
            catch (error) { setProxyNote(error.message, true); return; }
            const fields = { ...original[PROFILE_FIELD]?.fields };
            if (selectedSource === 'custom') {
                Object.assign(fields, { custom_url: endpoint.value.trim(), custom_model: updated.model, custom_prompt_post_processing: initialFields.custom_prompt_post_processing ?? profile['prompt-post-processing'] ?? '' }, customParameters);
                validateParameters(fields);
                if (!binding && !explicitlyNoKey) throw new Error('请选择密钥，或点击“不使用密钥”。');
                if (binding && !secret_state[binding.key]?.some(entry => entry.id === binding.id)) throw new Error('选择的密钥已删除，请重新选择。');
                const credential = binding ? approvedCredential(binding.key, binding.id, fields.custom_url) : { mode: 'none' };
                const previousCredential = original['custom-connection']?.credential;
                const previouslyApproved = previousCredential?.mode === 'reference' && previousCredential.key === binding?.key && previousCredential.id === binding?.id && previousCredential.endpoint === credential.endpoint;
                if (binding && credential.endpoint.startsWith('http:') && !previouslyApproved && !modelApprovals.has(JSON.stringify(credential)) && !await Popup.show.confirm('确认向此 HTTP 地址发送密钥？', '请确认这是你信任的本机或局域网 API 地址。', themedPopupOptions())) return;
                if (inputState() !== savingState) throw new Error('方案内容已变更，请重新保存。');
                updated['custom-connection'] = assertCustomCompatibility(editedCustomSnapshot(updated, fields, credential));
                updated['api-url'] = fields.custom_url;
                updated['prompt-post-processing'] = fields.custom_prompt_post_processing;
            } else {
                delete updated['custom-connection']; delete updated['api-url'];
                if (selectedSource === 'vertexai') Object.assign(fields, { vertexai_auth_mode: vertexMode.value, vertexai_region: region.value.trim(), vertexai_express_project_id: project.value.trim() });
                if (selectedSource === 'azure_openai') Object.assign(fields, Object.fromEntries(Object.entries(azureFields).map(([key, input]) => [key, input.value.trim()])));
                Object.assign(fields, Object.fromEntries(Object.entries(discoveryFields[selectedSource] ?? {}).map(([key, input]) => [key, input.value.trim()])));
            }
            updated[PROFILE_FIELD] = normalizeMetadata({ version: 1, source: selectedSource, model: updated.model, fields, proxy: selectedProxy, credential: binding });
            updated.exclude = (updated.exclude ?? []).filter(key => !['api', 'model', 'custom-connection', 'api-url', 'secret-id', 'proxy', 'prompt-post-processing'].includes(key));
            if (selectedProxy.mode === 'inherit') { delete updated.proxy; updated.exclude.push('proxy'); }
            else updated.proxy = selectedProxy.mode === 'none' ? creating ? 'None' : runtime.noProxyName?.() ?? 'None' : selectedProxy.name;
            if (binding && selectedSource !== 'vertexai' && binding.key === sourceKey(selectedSource)) updated['secret-id'] = binding.id;
            else delete updated['secret-id'];
            // Register before core's model command tries to select an as-yet unknown model ID.
            if (creating) created = await runtime.createConfigured(updated);
            else {
                if (updated.model && Object.hasOwn(CUSTOM_MODEL_SOURCES, selectedSource)) models.ensureOption(selectedSource, updated.model);
                await runtime.save(profile, updated);
                const current = runtime.selected();
                if (current?.id === profile.id) await runtime.select(current, { skipUnsavedCheck: true });
            }
            root.closest('dialog')?.querySelector('.popup-button-ok')?.click();
        } catch (error) { status.textContent = error.message; onError(error); }
        finally {
            for (const [control, disabled] of controlStates) control.disabled = disabled;
            saving = false;
            remove.disabled = typeof onDelete !== 'function';
            refreshModelLoading();
            refreshBindingButtons();
        }
    }, '', { textOnly: true });
    const remove = button('删除该方案', async () => {
        if (typeof onDelete !== 'function' || save.disabled || detachingBinding) return;
        deleting = true;
        save.disabled = true;
        if (modelController) {
            modelController.abort();
            setModelStatus('拉取已取消，可重新拉取。');
        }
        refreshModelLoading();
        refreshBindingButtons();
        try {
            if (await onDelete(profile)) root.closest('dialog')?.querySelector('.popup-button-ok')?.click();
        } catch (error) { status.textContent = error.message; onError(error); }
        finally { deleting = false; save.disabled = false; refreshModelLoading(); refreshBindingButtons(); }
    }, 'cw-delete-profile-action', { textOnly: true });
    remove.disabled = typeof onDelete !== 'function';
    root.append(element('h3', { text: creating ? '新建连接方案' : '编辑连接方案' }), controls, element('div', { class: 'cw-footer' }, [...(creating ? [] : [remove]), save]), status);
    controls.append(element('div', { class: 'cw-fields cw-profile-basics' }, [field('方案名称', name), field('API 来源', source)]),
        endpointField, azureContainer, vertexFields, ...Object.values(discoveryContainers),
        modelField, keyRow, proxyField, optionalBindings, customContainer);
    refreshSource();
    refreshBindingButtons();
    const editor = dialog(root);
    const removeSelects = installSearchableSelects({ root, selectors: ['select'], autoGroup: true, replaceExisting: true, onError });
    try { await editor; } finally { removeSelects(); modelController?.abort(); modelPicker.cleanup(); parameterControls?.cleanup(); }
    return creating ? created : undefined;
}
