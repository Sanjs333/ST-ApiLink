import { CLIENT_VERSION, eventSource, saveSettingsDebounced, resultCheckStatus, main_api, getRequestHeaders } from '../../../../script.js';
import { cancelStatusCheck } from './compat/status.js';
import { event_types } from './compat/events.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings, getChatCompletionModel } from '../../../openai.js';
import { refreshCustomConnection, installHostCompatibility, supportsNativeCustom } from './compat/host.js';
import { yaml } from './compat/libraries.js';
import { secret_state, rotateSecret } from '../../../secrets.js';
import { validateCustomSnapshot, captureCustomFields } from './compat/custom-connection.js';
import { addLocaleData, getCurrentLocale, translate } from '../../../i18n.js';
import { installApiSelects } from './native/api-selects.js';
import { installCustomModels, CUSTOM_MODEL_SOURCES } from './models/custom.js';
import { createProfileRuntime, sourceKey, isDispatchingProfile } from './profiles/runtime.js';
import { createSecretManager, secretName, MANAGED_SECRET_KEYS } from './secrets/manager.js';
import { editProfile, sourceLabel } from './profiles/editor.js';
import { element, button, dialog, field, searchInput, showError, installNativeSizing } from './ui/common.js';
import { continuousList, createUsageControls, bindListRow } from './ui/lists.js';
import { selectedProfiles, profileDeletionKeys } from './profiles/state.js';
import { confirmProfileDeletion, confirmUnsavedProfileSwitch } from './profiles/dialogs.js';
import { removeProfilesWithKeys } from './profiles/removal.js';
import { localizeOwnNodes, installConnectionDetailsLocalization } from './native/localization.js';
import { API_LOCALE, installApiLocalization } from './native/api-localization.js';
import { listMergedModels, removeMergedModel } from './models/legacy.js';
import { matchesIdleDays, compareUsageTimes, describeUsage } from './profiles/usage.js';
import { createProfileGroupControls } from './profiles/group-controls.js';
import { createParameterPresetStore } from './parameters/store.js';
import { installNativeParameterPresets } from './native/parameters.js';
import { installNativeModelControls } from './native/models.js';
import { fetchModelList } from './models/discovery.js';
import { manageCustomModels } from './models/manager.js';
import { installNativeChatUi } from './native/chat.js';

const TRANSLATIONS = {
    ...API_LOCALE,
    'Custom Providers': '自定义服务商', 'Choose a saved key': '请选择下面的已保存密钥',
    'No key': '不使用密钥', 'Captured Manual key selection': '沿用之前保存的旧密钥',
    'Pick one of your saved keys, or enter a new one below and click Connect.': '选择已保存密钥；免密接口请选择“不使用密钥”。也可输入新密钥后点击连接。',
    'Reset provider defaults': '恢复服务商默认设置', 'Advanced: show endpoint and connection details': '显示地址与连接详情',
    'Use these settings manually': '转为手动设置', 'Forget saved setup': '清理已保存的服务商设置',
    'Manage API keys': '管理 API 密钥', 'Could not load connection profile': '连接方案加载失败',
    'Proxy Preset': '代理预设', 'Custom connection': 'Custom 连接设置',
    'Send a key over HTTP?': '确认向此 HTTP 地址发送密钥？',
    'This API root is not encrypted. Only approve it on a trusted local network.': '请确认这是你信任的本机或局域网 API 地址。',
    'Choose a stored key for this connection before connecting.': '请先选择已保存密钥；免密接口请选择不使用密钥。',
    'Connection Profile': '连接方案', 'Included settings:': '随方案保存的设置：',
    'Profile name:': '方案名称：', 'Custom API Key': 'Custom API 密钥',
    'Create a new connection profile': '将当前连接另存为新方案', 'Update a connection profile': '用当前连接更新所选方案',
    'Edit a connection profile': '编辑连接方案', 'Reload a connection profile': '重新加载方案',
    'Delete a connection profile': '删除连接方案', 'View connection profile details': '查看方案详情',
    'extension unavailable': '服务商扩展未启用', 'Changed from the provider defaults.': '已修改服务商默认设置。',
    'Using the provider defaults.': '使用服务商默认设置。', 'Save and Update': '保存并更新',
    'No connection key selected': '当前连接没有绑定密钥',
};

let active = null;
const settings = () => {
    if (!extension_settings.connectionWorkbench) extension_settings.connectionWorkbench = { version: 1, models: {} };
    return extension_settings.connectionWorkbench;
};

export async function init() {
    if (active) return;
    const removers = [];
    const removeCompatibility = installHostCompatibility();
    const models = installCustomModels({ getSettings: settings, saveSettings: saveSettingsDebounced, onError: showError });
    const parameterPresets = createParameterPresetStore({ getSettings: settings, saveSettings: saveSettingsDebounced, parseYaml: value => yaml.parse(value) });
    let managerRender = null;
    let managerButton = null;
    let newConnectionButton = null;
    let profileToolbar = null;
    let noKeyControl = null;
    const hiddenLegacyButtons = new Set();
    const hiddenCredentialNodes = new Set();
    const keyInputAttributes = new Map();
    const keyToolbarRows = new Set();
    const nativeProfileControls = new Map();
    const draftOptionLabels = new Map();
    const runtime = createProfileRuntime({ models, onError: showError, onBeforeSwitch: beforeProfileSwitch, onChange: () => { renderStatus(); managerRender?.(); } });
    removers.push(installConnectionDetailsLocalization({ getProfile: () => runtime.selected() }));
    const vault = createSecretManager(runtime);
    let stopped = false;
    let pendingProfileSwitch = false;
    let pendingProfileSave = false;
    let releaseApiSave = null;
    const nativeParameters = installNativeParameterPresets({
        store: parameterPresets,
        getSource: () => main_api === 'openai' ? oai_settings.chat_completion_source : null,
        readFields: () => Object.fromEntries(['custom_include_headers', 'custom_include_body', 'custom_exclude_body'].map(key => [key, oai_settings[key] ?? ''])),
        writeFields: fields => {
            const changed = Object.entries(fields).filter(([key, value]) => oai_settings[key] !== value);
            if (!changed.length) return;
            const controls = changed.map(([key, value]) => [document.getElementById(key), key, value]);
            if (controls.every(([control]) => control?.tagName === 'TEXTAREA')) {
                for (const [control, , value] of controls) {
                    control.value = value;
                    control.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else {
                const providerId = oai_settings.custom_provider_state?.active?.provider?.id ?? null;
                Object.assign(oai_settings, fields);
                if (changed.some(([key]) => key === 'custom_include_headers')) {
                    cancelStatusCheck();
                    const error = document.getElementById('custom_provider_error');
                    if (error) error.textContent = '';
                    resultCheckStatus();
                }
                refreshCustomConnection();
                saveSettingsDebounced();
                void eventSource.emit(event_types.CUSTOM_CONNECTION_CHANGED, { oldProviderId: providerId, newProviderId: providerId, reason: 'edit' });
            }
        },
        onError: showError,
    });
    removers.push(nativeParameters.cleanup);
    for (const type of [event_types.CUSTOM_CONNECTION_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.MAIN_API_CHANGED].filter(Boolean)) {
        const refresh = detail => nativeParameters.refresh({ resetSelection: type !== event_types.CUSTOM_CONNECTION_CHANGED || detail?.reason !== 'edit' });
        eventSource.on(type, refresh);
        removers.push(() => eventSource.removeListener(type, refresh));
    }

    async function beforeProfileSwitch({ current, target }) {
        const action = await confirmUnsavedProfileSwitch({ current, target, draftName: runtime.newConnectionName?.() });
        if (action === 'cancel') return false;
        if (action === 'discard') return true;
        if (action === 'save-as') return Boolean(await saveCurrentAsProfile());
        try { if (current) await runtime.saveCurrentToSelected(); else await runtime.saveNewConnection(); return true; }
        catch (error) { showError(error); return false; }
    }

    function renderStatus() {
        if (stopped) return;
        if (managerButton) managerButton.title = '管理连接方案';
        if (newConnectionButton) {
            newConnectionButton.hidden = main_api !== 'openai';
            newConnectionButton.disabled = pendingProfileSwitch || pendingProfileSave;
        }
        projectProfileControls();
        projectCustomKeyRow();
    }

    function projectDraftName() {
        const name = runtime.newConnectionName?.();
        const option = document.querySelector('#connection_profiles option[value=""]');
        for (const [node, original] of draftOptionLabels) {
            if (node === option && name) continue;
            if (node.text === original.projected) node.text = original.text;
            draftOptionLabels.delete(node);
        }
        if (!option || !name) return;
        const projected = `${name}（未保存）`;
        if (!draftOptionLabels.has(option)) draftOptionLabels.set(option, { text: option.text, projected });
        draftOptionLabels.get(option).projected = projected;
        if (option.text !== projected) option.text = projected;
    }

    function projectProfileControls() {
        projectDraftName();
        const manualSave = main_api === 'openai' && !runtime.selected();
        const specs = [
            ['create_connection_profile', '将当前连接另存为新方案'],
            ['update_connection_profile', manualSave ? runtime.newConnectionName?.() ? '保存新连接方案' : '保存连接方案' : '用当前连接更新所选方案'],
            ['edit_connection_profile', '编辑连接方案', ['fa-pen', 'fa-pencil', 'fa-pen-to-square', 'fa-pen-nib']],
            ['reload_connection_profile', '重新加载方案', ['fa-arrows-rotate', 'fa-recycle']],
            ['delete_connection_profile', '删除连接方案', ['fa-trash', 'fa-trash-can']],
        ];
        for (const [id, title, icons = []] of specs) {
            const control = document.getElementById(id);
            if (!control) continue;
            if (!nativeProfileControls.has(control)) nativeProfileControls.set(control, {
                title: control.getAttribute('title'), ariaLabel: control.getAttribute('aria-label'),
                icons: icons.map(icon => [icon, control.classList.contains(icon)]),
                createHidden: control.classList.contains('cw-managed-create-profile'),
                disabled: control.getAttribute('disabled'), ariaDisabled: control.getAttribute('aria-disabled'), manualSave: false,
            });
            if (control.title !== title) control.title = title;
            if (control.getAttribute('aria-label') !== title) control.setAttribute('aria-label', title);
            if (id === 'create_connection_profile') control.classList.remove('cw-managed-create-profile');
            if (id === 'update_connection_profile') {
                const original = nativeProfileControls.get(control);
                control.classList.toggle('cw-save-unselected-profile', manualSave);
                if (manualSave || pendingProfileSave) {
                    const disabled = pendingProfileSwitch || pendingProfileSave;
                    control.classList.toggle('disabled', disabled);
                    control.toggleAttribute('disabled', disabled);
                    control.setAttribute('aria-disabled', String(disabled));
                    original.manualSave = true;
                } else if (original.manualSave) {
                    control.classList.toggle('disabled', !runtime.selected());
                    for (const [attribute, value] of [['disabled', original.disabled], ['aria-disabled', original.ariaDisabled]]) {
                        if (value === null) control.removeAttribute(attribute); else control.setAttribute(attribute, value);
                    }
                    original.manualSave = false;
                }
            }
            if (icons.length) {
                control.classList.remove(...icons.slice(1));
                control.classList.add(icons[0]);
            }
        }
    }

    function hideCredentialNode(node) {
        if (!node || node.classList.contains('cw-merged-credential-hidden')) return;
        hiddenCredentialNodes.add(node);
        node.classList.add('cw-merged-credential-hidden');
    }

    function projectCustomKeyRow() {
        const select = document.getElementById('custom_credential_select');
        const help = document.getElementById('custom_credential_info');
        const container = document.getElementById('custom_credential_binding');
        const known = new Set([select, help].filter(Boolean));
        const picker = select?.nextElementSibling;
        if (picker?.classList.contains('cw-picker')) known.add(picker);
        const select2 = document.getElementById('select2-custom_credential_select-container')?.closest('.select2-container');
        if (select2) known.add(select2);
        for (const node of known) hideCredentialNode(node);
        if (container) {
            // Preserve foreign content inserted into this block; hide only the original credential controls.
            const onlyKnownControls = [...container.children].every(node => known.has(node))
                && [...container.childNodes].every(node => node.nodeType !== Node.TEXT_NODE || !node.textContent.trim());
            if (onlyKnownControls) hideCredentialNode(container);
            else if (hiddenCredentialNodes.delete(container)) container.classList.remove('cw-merged-credential-hidden');
        }
        const input = document.getElementById('api_key_custom');
        const row = input?.parentElement;
        if (!input || !row) return;
        if (!keyInputAttributes.has(input)) keyInputAttributes.set(input, Object.fromEntries(['placeholder', 'title', 'aria-label'].map(name => [name, input.getAttribute(name)])));
        if (!row.classList.contains('cw-key-toolbar')) { row.classList.add('cw-key-toolbar'); keyToolbarRows.add(row); }
        if (!noKeyControl) {
            noKeyControl = button('不使用密钥', guarded(() => {
                const result = runtime.toggleNoKey();
                if (!result.enabled && !result.restored) toastr.info(result.message, 'API 连接管理');
                return result;
            }), 'cw-inline-no-key');
            noKeyControl.id = 'connection-workbench-no-key';
        }
        if (noKeyControl.parentElement !== row) row.append(noKeyControl);
        const custom = main_api === 'openai' && oai_settings.chat_completion_source === 'custom';
        const base = oai_settings.custom_provider_state?.active;
        const enabled = runtime.isNoKey();
        noKeyControl.hidden = !custom || Boolean(base?.auth.required);
        noKeyControl.disabled = base?.auth.mode === 'none';
        noKeyControl.classList.toggle('active', enabled);
        noKeyControl.setAttribute('aria-pressed', String(enabled));
        noKeyControl.title = base?.auth.mode === 'none' ? '此服务固定不使用密钥' : enabled ? '取消不使用密钥' : '不使用密钥';
        noKeyControl.setAttribute('aria-label', noKeyControl.title);
        if (!custom) return;
        const binding = runtime.currentCredential();
        const entry = binding && secret_state[binding.key]?.find(item => item.id === binding.id);
        const text = enabled ? '不使用密钥' : entry ? '已保存密钥：' + (entry.label || '未命名密钥')
            : binding ? '保存的密钥已删除，请点击钥匙重新选择' : '输入新密钥，或点击钥匙选择已保存密钥';
        if (input.getAttribute('placeholder') !== text) input.setAttribute('placeholder', text);
        if (input.getAttribute('title') !== text) input.setAttribute('title', text);
        if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', 'Custom API 密钥');
    }

    async function openNativeKeyManager(key) {
        const source = oai_settings.chat_completion_source;
        const chat = main_api === 'openai';
        const selectable = chat && source === 'custom' ? vault.customKeys : [chat ? sourceKey(source, oai_settings) : key];
        const policy = oai_settings.custom_provider_state?.active?.auth;
        const optional = chat && source === 'custom' && !policy?.required && policy?.mode !== 'none';
        const initialContext = runtime.keyContext();
        const sameContext = () => JSON.stringify(runtime.keyContext()) === JSON.stringify(initialContext);
        const assertContext = () => { if (!sameContext()) throw new Error('连接已切换，请关闭并重新打开密钥管理。'); };
        await vault.open({ title: '管理 API 密钥', defaultKey: chat && source === 'custom' ? runtime.currentCredential()?.key ?? key : key,
            canChoose: entry => selectable.includes(entry.key),
            getChosen: () => chat ? runtime.currentCredential() : { key, id: secret_state[key]?.find(item => item.active)?.id },
            onChoose: async entry => {
                assertContext();
                if (chat) return runtime.bindCurrent(entry.key, entry.id);
                await rotateSecret(entry.key, entry.id);
                if (!secret_state[entry.key]?.some(item => item.id === entry.id && item.active)) throw new Error('密钥未能切换，请重试。');
                return true;
            }, onNone: optional ? () => { assertContext(); return runtime.toggleNoKey(); } : null,
            isNone: () => optional && sameContext() && runtime.isNoKey() });
    }
    const guarded = action => async () => { try { await action(); } catch (error) { showError(error); } };

    async function saveCurrentAsProfile() {
        const root = element('div', { class: 'cw-dialog cw-editor cw-save-current-profile' });
        const model = getChatCompletionModel() || '';
        const source = sourceLabel(oai_settings.chat_completion_source);
        const name = element('input', { class: 'text_pole', value: runtime.newConnectionName?.() || `${source} ${model}`.trim(), autocomplete: 'off', 'aria-label': '方案名称' });
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        let created = null, saving = false;
        const save = button('保存', async () => {
            saving = true;
            name.disabled = true;
            try {
                created = await (runtime.createFromCurrent ? runtime.createFromCurrent(name.value.trim()) : runtime.create(name.value.trim()));
                toastr.success('当前连接已保存为新方案。', 'API 连接管理');
                root.closest('dialog')?.querySelector('.popup-button-ok')?.click();
            } catch (error) { status.textContent = error.message; showError(error); }
            finally { saving = false; name.disabled = false; }
        }, '', { textOnly: true });
        name.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); save.click(); }
        });
        root.append(element('h3', { text: '保存当前连接为新方案' }),
            field('方案名称', name), status,
            element('div', { class: 'cw-footer' }, [save]));
        await dialog(root, { onClosing: () => !saving || Boolean(created) });
        return created;
    }

    async function nameNewConnection() {
        const root = element('div', { class: 'cw-dialog cw-editor cw-new-connection' });
        const name = element('input', { class: 'text_pole', autocomplete: 'off', maxLength: 128, placeholder: '例如：我的 API 连接', 'aria-label': '方案名称' });
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        let chosen = null;
        const create = button('新建', () => {
            try {
                chosen = runtime.validateNewConnectionName(name.value);
                root.closest('dialog')?.querySelector('.popup-button-ok')?.click();
            } catch (error) { status.textContent = error.message; }
        }, '', { textOnly: true });
        name.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); create.click(); }
        });
        name.addEventListener('input', () => { status.textContent = ''; });
        root.append(element('h3', { text: '新建连接方案' }), field('方案名称', name),
            status,
            element('div', { class: 'cw-footer' }, [create]));
        await dialog(root, { okButton: '取消' });
        return chosen;
    }

    async function deletionOptions(targets) {
        await runtime.refresh();
        const plan = profileDeletionKeys(targets, runtime.profiles(), secret_state, sourceKey);
        const choice = await confirmProfileDeletion(targets, plan);
        return choice && { ...choice, allowedKeys: plan.removable };
    }

    function deletionMessage(result, deleteKeys) {
        return `已删除 ${result.completed} 个方案` + (result.failed ? `，${result.failed} 个失败，可重试` : '')
            + (deleteKeys ? `；删除 ${result.keysDeleted} 把密钥` + (result.keysRetained ? `，保留 ${result.keysRetained} 把` : '')
                + (result.keysFailed ? `，${result.keysFailed} 把删除失败，请到密钥管理重试` : '') : '');
    }

    async function removeProfiles(ids, options, { onProgress, shouldStop } = {}) {
        const result = await removeProfilesWithKeys({ ids, getProfiles: runtime.profiles, getVault: () => secret_state,
            resolveSourceKey: sourceKey, removeProfile: profile => runtime.remove(profile), removeKey: (key, id) => vault.remove(key, id),
            ...options, onProgress, shouldStop });
        if (options.deleteKeys) await runtime.refresh();
        return result;
    }

    async function deleteProfile(profile) {
        const current = runtime.profiles().find(entry => entry.id === profile.id);
        if (!current) return true;
        const options = await deletionOptions([current]);
        if (!options) return false;
        const result = await runtime.batch(() => removeProfiles([current.id], options));
        const message = deletionMessage(result, options.deleteKeys);
        if (result.failed || result.keysFailed) toastr.warning(message, '删除连接方案');
        else toastr.success(message, '删除连接方案');
        return result.completed > 0;
    }

    async function deleteCurrentProfile() {
        const profile = runtime.selected();
        if (profile) return deleteProfile(profile);
    }

    async function openProfiles() {
        if (managerRender) return;
        const root = element('div', { class: 'cw-dialog cw-manager' });
        const list = element('div', { class: 'cw-list', id: 'cw-profile-manager-list' });
        const selection = new Set();
        let busy = false, closed = false, multi = false, connectingId = null;
        const query = searchInput('搜索方案名称、API 或模型', () => render(true));
        const count = element('span', { class: 'cw-note cw-bulk-count' });
        const total = element('span', { class: 'cw-note' });
        const progress = element('div', { class: 'cw-progress cw-note', role: 'status' });
        const usageControls = createUsageControls({ kind: 'profile', onChange: () => render(true) });
        const groups = runtime.groups ? createProfileGroupControls({
            runtime, models, onChange: reset => render(reset),
            onEdit: profile => editProfile(profile, { runtime, vault, models, parameterPresets, onDelete: deleteProfile }),
            getSelectedIds: () => [...selection], getMulti: () => multi,
            getSearching: () => Boolean(query.value.trim()),
            isBusy: () => busy, onError: showError,
        }) : null;
        const profileTime = profile => runtime.usage?.profileTime(profile.id) ?? null;
        const filtered = () => {
            const term = query.value.trim().toLocaleLowerCase();
            const now = Date.now();
            const currentId = runtime.selected()?.id;
            const profiles = runtime.profiles();
            const validIds = new Set(profiles.map(profile => profile.id));
            for (const id of selection) if (!validIds.has(id)) selection.delete(id);
            const times = new Map(profiles.map(profile => [profile.id, profileTime(profile)]));
            return profiles.filter(profile => (!groups || groups.matches(profile))
                && (!term || [profile.name, profile.api, profile.model, groups?.searchable(profile) ?? ''].join(' ').toLocaleLowerCase().includes(term))
                && matchesIdleDays(times.get(profile.id), usageControls.days, now))
                .sort((a, b) => Number(b.id === currentId) - Number(a.id === currentId)
                    || compareUsageTimes(times.get(a.id), times.get(b.id), usageControls.oldestFirst) || a.name.localeCompare(b.name));
        };
        let visibleProfiles = [], visibleProfileIds = new Set(), selectedVisibleCount = 0;
        const setSelected = (id, selected) => {
            const wasSelected = selection.has(id);
            if (wasSelected === selected) return;
            if (selected) selection.add(id); else selection.delete(id);
            if (visibleProfileIds.has(id)) selectedVisibleCount += selected ? 1 : -1;
        };
        const selectAll = element('input', { type: 'checkbox', title: '全选搜索结果', 'aria-label': '全选搜索结果', onchange: () => {
            scroller.preservePosition(() => {
                for (const profile of visibleProfiles) {
                    if (selectAll.checked) selection.add(profile.id); else selection.delete(profile.id);
                }
                selectedVisibleCount = selectAll.checked ? visibleProfiles.length : 0;
                updateControls();
            });
        } });
        const bulkCopy = button('复制所选', guarded(() => batchAction(false)));
        const bulkDelete = button('删除所选', guarded(() => batchAction(true)));
        const clear = button('清空选择', () => scroller.preservePosition(() => { selection.clear(); selectedVisibleCount = 0; updateControls(); }));
        const toggle = button('多选', () => scroller.preservePosition(() => {
            multi = !multi;
            if (!multi) { selection.clear(); selectedVisibleCount = 0; }
            usageControls.setMulti(multi);
            render();
        }), 'cw-multi-toggle');
        const scroller = continuousList(list, profile => {
                if (profile.kind === 'group') return groups.renderHeading(profile);
                const problems = runtime.problems(profile);
                const checkbox = element('input', { type: 'checkbox', value: profile.id, hidden: !multi, checked: selection.has(profile.id), 'aria-label': '选择方案 ' + profile.name, onchange: () => {
                    setSelected(profile.id, checkbox.checked);
                    updateControls(checkbox.closest('.cw-profile-row'));
                } });
                const info = element('div', { class: 'cw-row-info' }, [element('span', { class: 'cw-row-title', text: profile.name }), element('small', { class: 'cw-note', text: [runtime.groupFor?.(profile) ? '' : sourceLabel(profile.api === 'google' ? 'makersuite' : profile.api), profile.model || '未保存模型'].filter(Boolean).join(' · ') })]);
                const usage = describeUsage(profileTime(profile));
                info.append(element('small', { class: 'cw-note', text: '最近加载：' + usage.text, title: usage.title || '启用记录后尚未记录到此方案的加载时间' }));
                if (problems.length) info.append(element('div', { class: 'cw-warning', text: problems.join('；') }));
                const actions = element('div', { class: 'cw-row-actions' }, [
                    button('复制已存方案', guarded(async () => {
                        busy = true; updateControls();
                        try {
                            await runtime.duplicate(profile);
                            progress.textContent = `已复制「${profile.name}」的已保存配置`;
                        } finally { busy = false; render(); }
                    })),
                    button(problems.length ? '修复' : '编辑', guarded(async () => {
                        if (profile.mode !== 'cc') throw new Error('文本补全方案请使用原生编辑；这里可以直接复制或删除。');
                        await editProfile(profile, { runtime, vault, models, parameterPresets, onDelete: deleteProfile });
                        if (!runtime.profiles().some(entry => entry.id === profile.id)) selection.delete(profile.id);
                        render();
                    })),
                ]);
                const row = element('div', { class: 'cw-list-row cw-profile-row' + (runtime.groupFor?.(profile) ? ' cw-group-member' : '') }, [checkbox, info, actions]);
                return bindListRow(row, {
                    label: profile.name, isMulti: () => multi, isSelected: () => selection.has(profile.id),
                    isDisabled: () => busy, isCurrent: () => profile.id === runtime.selected()?.id,
                    isConnecting: () => connectingId === profile.id, onError: showError,
                    toggleSelected: () => { setSelected(profile.id, !selection.has(profile.id)); updateControls(checkbox.closest('.cw-profile-row')); },
                    activate: async ({ keyboard }) => {
                        busy = true; connectingId = profile.id; updateControls();
                        let success = false;
                        try {
                            const switched = await runtime.select(profile);
                            if (switched === false) return;
                            if (runtime.selected()?.id !== profile.id) throw new Error('方案未能切换，请重试。');
                            success = true;
                        } finally {
                            busy = false; connectingId = null; render(success);
                            if (success && keyboard) list.querySelector('[aria-current="true"][tabindex="0"]')?.focus({ preventScroll: true });
                        }
                    },
                });
        }, { emptyText: '没有匹配的连接方案', batchSize: 20 });
        function updateControls(changedRow) {
            const entries = visibleProfiles;
            const selected = selection.size;
            const inView = selectedVisibleCount;
            bulkControls.hidden = !multi;
            total.hidden = multi;
            total.textContent = `共 ${entries.length} 个`;
            toggle.disabled = busy;
            toggle.classList.toggle('active', multi);
            toggle.setAttribute('aria-pressed', String(multi));
            toggle.title = multi ? '退出多选' : '多选';
            toggle.setAttribute('aria-label', toggle.title);
            selectAll.checked = entries.length > 0 && inView === entries.length;
            selectAll.indeterminate = inView > 0 && inView < entries.length;
            selectAll.disabled = busy || !entries.length;
            count.textContent = `共 ${entries.length} 个 · 已选 ${selected} 个`;
            const hidden = selected - inView;
            count.title = hidden ? `其中 ${hidden} 个不在当前筛选结果中，批量操作包含这些已选方案` : '批量操作包含全部已选方案';
            selectionNote.textContent = hidden ? `已选 ${selected} 个方案，其中 ${hidden} 个不在当前筛选结果中` : '';
            selectionNote.hidden = !multi || !hidden;
            bulkCopy.disabled = bulkDelete.disabled = clear.disabled = busy || !selected;
            query.disabled = busy;
            usageControls.setDisabled(busy);
            groups?.update();
            if (changedRow?.cwRefreshState) {
                const checkbox = changedRow.querySelector('input[type="checkbox"]');
                checkbox.checked = selection.has(checkbox.value);
                changedRow.cwRefreshState();
                return;
            }
            for (const control of list.querySelectorAll('button, input[type="checkbox"]')) if (control.disabled !== busy) control.disabled = busy;
            for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
                checkbox.hidden = !multi;
                checkbox.checked = selection.has(checkbox.value);
            }
            for (const row of scroller.loadedRows()) row.cwRefreshState?.();
        }
        function render(reset = false) {
            if (closed) return;
            visibleProfiles = filtered();
            visibleProfileIds = new Set(visibleProfiles.map(profile => profile.id));
            selectedVisibleCount = visibleProfiles.reduce((count, profile) => count + Number(selection.has(profile.id)), 0);
            if (!busy) {
                const entries = visibleProfiles;
                scroller.setItems(groups ? groups.rows(entries, { searching: Boolean(query.value.trim()), multi }) : entries, { reset });
            }
            updateControls();
        }
        async function batchAction(remove) {
            const targets = selectedProfiles(runtime.profiles(), new Set(selection)).map(profile => profile.id);
            if (!targets.length) throw new Error('请先勾选连接方案。');
            const options = remove ? await deletionOptions(selectedProfiles(runtime.profiles(), targets)) : null;
            if (remove && !options) return;
            busy = true; updateControls();
            let completed = 0, failed = 0;
            let deletionResult = null;
            try {
                await runtime.batch(async () => {
                    if (remove) {
                        deletionResult = await removeProfiles(targets, options, { shouldStop: () => closed,
                            onProgress: ({ phase, index, total }) => {
                                progress.textContent = `正在删除${phase === 'keys' ? '密钥' : '方案'} ${index} / ${total}…`;
                            } });
                        for (const id of deletionResult.removedIds) selection.delete(id);
                        completed = deletionResult.completed; failed = deletionResult.failed;
                        return;
                    }
                    for (const id of targets) {
                        if (closed) break;
                        const profile = runtime.profiles().find(entry => entry.id === id);
                        if (!profile) { selection.delete(id); continue; }
                        progress.textContent = `正在${remove ? '删除' : '复制'} ${completed + failed + 1} / ${targets.length}…`;
                        try {
                            await runtime.duplicate(profile); completed++;
                        } catch { failed++; }
                    }
                });
            } finally { busy = false; render(); }
            progress.textContent = remove ? deletionMessage(deletionResult, options.deleteKeys)
                : `已复制 ${completed} 个方案` + (failed ? `，${failed} 个失败，可重试` : '');
        }
        managerRender = render;
        const selectionNote = element('div', { class: 'cw-note cw-selection-note', hidden: true, role: 'status' });
        const bulkControls = element('div', { class: 'cw-bulk' }, [selectAll, count, clear, ...(groups ? [groups.assignButton] : []), bulkCopy, bulkDelete]);
        root.addEventListener('cw-action-settled', updateControls);
        root.append(element('div', { class: 'cw-header' }, [element('h3', { text: '管理连接方案' }), total, ...(groups ? [groups.stateButton] : []), usageControls.sortButton, ...(groups ? [groups.createButton] : []), toggle]),
            groups ? element('div', { class: 'cw-search-row' }, [query, groups.filter]) : query,
            usageControls.filterRow, bulkControls, selectionNote, list, progress);
        const unsubscribeUsage = runtime.usage?.subscribe(() => render());
        render();
        try { await dialog(root); } finally { closed = true; managerRender = null; unsubscribeUsage?.(); scroller.cleanup(); }
    }

    async function openModels(initialSource = oai_settings.chat_completion_source) {
        await manageCustomModels({ initialSource,
            getActiveModel: source => oai_settings[CUSTOM_MODEL_SOURCES[source]?.field],
            listModels: source => listMergedModels(models, () => extension_settings, source),
            addModel: (source, id, label) => models.add(source, id, label),
            useModel: (source, id) => models.select(source, id),
            removeModel: (source, id) => removeMergedModel(models, source, id, {
                extensionSettings: extension_settings, documentRef: document,
                chatCompletionSettings: oai_settings, saveSettings: saveSettingsDebounced,
            }),
            onError: showError,
        });
    }

    function enhanceLabels() {
        if (stopped) return;
        projectProfileControls();
        projectCustomKeyRow();
        const select = document.getElementById('custom_credential_select');
        const keyMaps = new Map();
        if (select) for (const option of select.options) {
            if (option.value === 'unbound') {
                if (option.text !== '请选择下面的已保存密钥') option.text = '请选择下面的已保存密钥';
                option.disabled = true;
            }
            if (option.value === 'legacy') {
                const binding = runtime.currentCredential();
                const saved = binding && secret_state[binding.key]?.find(entry => entry.id === binding.id);
                const remembered = oai_settings.custom_provider_state?.active?.credential;
                const text = saved ? '沿用旧密钥：' + saved.label : remembered?.id === null ? '沿用旧设置：不使用密钥' : '旧密钥已失效，请重新选择';
                if (option.text !== text) option.text = text;
                option.disabled = true;
            }
            if (option.value === 'none' && option.text !== '不使用密钥') option.text = '不使用密钥';
            if (option.value.startsWith('[')) {
                try {
                    const [key, id] = JSON.parse(option.value);
                    if (!keyMaps.has(key)) keyMaps.set(key, new Map((secret_state[key] ?? []).map(entry => [entry.id, entry])));
                    const entry = keyMaps.get(key).get(id);
                    if (entry) {
                        const text = secretName(key) + '：' + (entry.label || '未命名密钥');
                        if (option.text !== text) option.text = text;
                    }
                } catch { /* Preserve options added by another extension in a different format. */ }
            }
        }
        for (const [source, config] of Object.entries(CUSTOM_MODEL_SOURCES)) {
            const select = document.querySelector(config.selector);
            let heading = null;
            for (let control = select; control?.parentElement && control.parentElement.id !== 'openai_api'; control = control.parentElement) {
                for (let previous = control.previousElementSibling; previous; previous = previous.previousElementSibling) {
                    if (previous.tagName === 'H4') { heading = previous; break; }
                }
                if (heading) break;
            }
            if (heading) for (const legacyButton of heading.querySelectorAll('.stcm--btn')) {
                legacyButton.classList.add('cw-model-legacy-hidden');
                hiddenLegacyButtons.add(legacyButton);
                const legacyKey = CUSTOM_MODEL_SOURCES[source].field.replace(/_model$/, '');
                const savedLegacy = extension_settings.customModels?.provider?.[legacyKey];
                const ids = Array.isArray(savedLegacy) ? [...savedLegacy].sort() : [];
                const groups = [...(select?.querySelectorAll('optgroup') ?? [])].filter(group => group.label === 'Custom Models' && JSON.stringify([...group.children].map(option => option.value).sort()) === JSON.stringify(ids));
                if (groups.length === 1) groups[0].setAttribute('data-connection-workbench-legacy-models', source);
            }
        }
    }

    function mount() {
        if (stopped || managerButton?.isConnected) return;
        const anchor = document.getElementById('view_connection_profile');
        if (!anchor) return;
        managerButton = button('管理方案', guarded(openProfiles), 'cw-profile-manager');
        managerButton.id = 'connection-workbench-manage-profiles';
        newConnectionButton = button('新建空白连接', guarded(async () => {
            if (pendingProfileSwitch || pendingProfileSave) return;
            pendingProfileSwitch = true;
            renderStatus();
            try {
                const name = await nameNewConnection();
                if (name && await runtime.startNewConnection({ name })) {
                    const input = document.getElementById(oai_settings.chat_completion_source === 'custom' ? 'custom_api_url_text'
                        : oai_settings.chat_completion_source === 'azure_openai' ? 'azure_base_url' : '');
                    input?.focus();
                }
            } finally { pendingProfileSwitch = false; renderStatus(); }
        }), 'cw-profile-new');
        newConnectionButton.id = 'connection-workbench-new-connection';
        anchor.after(newConnectionButton, managerButton);
        profileToolbar = anchor.parentElement;
        profileToolbar.classList.add('cw-profile-toolbar');
        renderStatus();
    }

    function captureClick(event) {
        if (stopped) return;
        if (pendingProfileSave && event.target.closest?.('#update_connection_profile, #create_connection_profile, #edit_connection_profile, #reload_connection_profile, #delete_connection_profile')) {
            event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        const manager = event.target.closest?.('.manage-api-keys');
        if (manager && manager.closest('#rm_api_block') && MANAGED_SECRET_KEYS.includes(manager.dataset.key)) {
            event.preventDefault(); event.stopImmediatePropagation();
            void guarded(() => openNativeKeyManager(manager.dataset.key))();
            return;
        }
        if (event.target.closest?.('#create_connection_profile') && main_api === 'openai') {
            event.preventDefault(); event.stopImmediatePropagation();
            if (!pendingProfileSwitch && !pendingProfileSave) void guarded(saveCurrentAsProfile)();
            return;
        }
        if (event.target.closest?.('#update_connection_profile') && main_api === 'openai' && !runtime.selected()) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (pendingProfileSwitch || pendingProfileSave) return;
            pendingProfileSave = true; renderStatus();
            const api = document.getElementById('rm_api_block');
            const wasInert = api?.inert;
            if (api) api.inert = true;
            releaseApiSave = () => { if (api) api.inert = wasInert; releaseApiSave = null; };
            void guarded(async () => {
                try {
                    if (runtime.newConnectionName?.()) {
                        await runtime.saveNewConnection();
                        toastr.success('连接方案已保存。', 'API 连接管理');
                    } else await saveCurrentAsProfile();
                } finally { releaseApiSave?.(); pendingProfileSave = false; renderStatus(); }
            })();
            return;
        }
        if (event.target.closest?.('#delete_connection_profile') && runtime.selected()) {
            event.preventDefault(); event.stopImmediatePropagation();
            void guarded(deleteCurrentProfile)(); return;
        }
        if (event.target.closest?.('#reload_connection_profile') && runtime.selected() && (!supportsNativeCustom || runtime.hasUnsavedChanges?.())) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (pendingProfileSwitch) return;
            const current = runtime.selected();
            pendingProfileSwitch = true;
            void guarded(async () => {
                try { if (!runtime.hasUnsavedChanges?.() || await beforeProfileSwitch({ current, target: current })) await runtime.select(current, { skipUnsavedCheck: true }); }
                finally { pendingProfileSwitch = false; renderStatus(); }
            })();
            return;
        }
        if (event.target.closest?.('#edit_connection_profile') && runtime.selected()?.mode === 'cc') {
            event.preventDefault(); event.stopImmediatePropagation();
            void guarded(() => editProfile(runtime.selected(), { runtime, vault, models, parameterPresets, onDelete: deleteProfile }))();
        }
    }
    function captureChange(event) {
        if (event.target.id === 'connection_profiles') {
            if (isDispatchingProfile()) return;
            const profile = runtime.profiles().find(entry => entry.id === event.target.value);
            const restore = () => { event.target.value = runtime.selected()?.id ?? ''; };
            if (pendingProfileSwitch || pendingProfileSave) { event.preventDefault(); event.stopImmediatePropagation(); restore(); return; }
            if (event.target.value === (runtime.selected()?.id ?? '') && runtime.hasUnsavedChanges?.()) {
                event.preventDefault(); event.stopImmediatePropagation(); return;
            }
            if (profile) {
                try { runtime.validate(profile); }
                catch (error) { event.preventDefault(); event.stopImmediatePropagation(); restore(); showError(error); return; }
            }
            if (event.target.value !== (runtime.selected()?.id ?? '') && (!supportsNativeCustom || runtime.hasUnsavedChanges?.())) {
                event.preventDefault(); event.stopImmediatePropagation(); restore();
                pendingProfileSwitch = true;
                void guarded(async () => {
                    try { if (profile) await runtime.select(profile); else await runtime.deselect(); }
                    finally { pendingProfileSwitch = false; renderStatus(); }
                })();
            }
            return;
        }
        if (event.target.id !== 'custom_credential_select') return;
        const state = oai_settings.custom_provider_state;
        if (!state?.active || state.version !== 1) return;
        // A deliberate replacement should not be blocked by validation of an obsolete root binding.
        try { validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...state.active }); }
        catch { state.active.credential = state.active.auth.mode === 'none' ? { mode: 'none' } : { mode: 'unbound' }; }
    }
    document.addEventListener('click', captureClick, true);
    document.addEventListener('change', captureChange, true);
    removers.push(() => document.removeEventListener('click', captureClick, true), () => document.removeEventListener('change', captureChange, true));
    let renderTimer = null;
    const labelControls = ['#custom_credential_select', '#custom_credential_binding', '#connection_profiles',
        ...Object.values(CUSTOM_MODEL_SOURCES).map(config => config.selector)].join(', ');
    const labelMounts = labelControls + ', #view_connection_profile, .stcm--btn';
    const observer = new MutationObserver(records => {
        if (stopped || renderTimer !== null || !records.some(record => record.target instanceof Element
            && (record.target.closest(labelControls) || [...record.addedNodes].some(node => node instanceof Element
                && (node.matches(labelMounts) || node.querySelector(labelMounts)))))) return;
        renderTimer = setTimeout(() => { renderTimer = null; mount(); enhanceLabels(); }, 30);
    });
    observer.observe(document.getElementById('rm_api_block') ?? document.body, { childList: true, subtree: true });
    removers.push(() => { observer.disconnect(); clearTimeout(renderTimer); });
    const ready = () => { addLocaleData('zh-cn', TRANSLATIONS); mount(); localizeOwnNodes(document, TRANSLATIONS, translate); enhanceLabels(); renderStatus(); if (runtime.groups?.().length) runtime.syncProfileList?.(); };
    eventSource.on(event_types.APP_READY, ready);
    eventSource.on(event_types.MAIN_API_CHANGED, renderStatus);
    removers.push(() => eventSource.removeListener(event_types.APP_READY, ready), () => eventSource.removeListener(event_types.MAIN_API_CHANGED, renderStatus));
    const nativeModels = installNativeModelControls({ onOpen: openModels, onError: showError,
        onSelectCatalog: (source, entry) => models.ensureOption(source, entry.id, entry.label),
        getSource: () => main_api === 'openai' ? oai_settings.chat_completion_source : null,
        getModelContext: () => JSON.stringify([main_api, oai_settings.chat_completion_source, oai_settings.vertexai_auth_mode,
            oai_settings.vertexai_region, secret_state.vertexai_service_account_json?.find(entry => entry.active)?.id]),
        onRefresh: async (source, { signal }) => {
            const request = { chat_completion_source: source, vertexai_auth_mode: oai_settings.vertexai_auth_mode,
                vertexai_region: oai_settings.vertexai_region,
                secret_id: secret_state.vertexai_service_account_json?.find(entry => entry.active)?.id };
            return fetchModelList(request, { headers: getRequestHeaders(), signal });
        },
    });
    const nativeChat = installNativeChatUi({ onError: showError });
    removers.push(nativeModels.cleanup, nativeChat.cleanup);
    const removePickers = installApiSelects({ onError: showError });
    removers.push(removePickers);
    removers.push(installNativeSizing(), installApiLocalization(getCurrentLocale()));
    addLocaleData('zh-cn', TRANSLATIONS);
    localizeOwnNodes(document, TRANSLATIONS, translate);
    refreshCustomConnection();
    mount(); enhanceLabels();
    if (runtime.groups?.().length) runtime.syncProfileList?.();
    active = {
        runtime, vault, models,
        cleanup() {
            stopped = true;
            releaseApiSave?.();
            for (const remove of removers.reverse()) remove();
            runtime.cleanup(); vault.cleanup(); models.cleanup(); removeCompatibility(); newConnectionButton?.remove(); managerButton?.remove(); profileToolbar?.classList.remove('cw-profile-toolbar');
            for (const [control, original] of nativeProfileControls) {
                if (control.id === 'create_connection_profile') control.classList.toggle('cw-managed-create-profile', original.createHidden);
                for (const [icon, present] of original.icons) control.classList.toggle(icon, present);
                for (const [attribute, value] of [['title', original.title], ['aria-label', original.ariaLabel]]) {
                    if (value === null) control.removeAttribute(attribute); else control.setAttribute(attribute, value);
                }
                if (control.id === 'update_connection_profile') {
                    control.classList.remove('cw-save-unselected-profile');
                    control.classList.toggle('disabled', !runtime.selected());
                    for (const [attribute, value] of [['disabled', original.disabled], ['aria-disabled', original.ariaDisabled]]) {
                        if (value === null) control.removeAttribute(attribute); else control.setAttribute(attribute, value);
                    }
                }
            }
            for (const [option, original] of draftOptionLabels) if (option.text === original.projected) option.text = original.text;
            draftOptionLabels.clear();
            noKeyControl?.remove();
            for (const node of hiddenCredentialNodes) node.classList.remove('cw-merged-credential-hidden');
            for (const row of keyToolbarRows) row.classList.remove('cw-key-toolbar');
            for (const [input, attributes] of keyInputAttributes) for (const [name, value] of Object.entries(attributes)) {
                if (value === null) input.removeAttribute(name); else input.setAttribute(name, value);
            }
            for (const legacyButton of hiddenLegacyButtons) legacyButton.classList.remove('cw-model-legacy-hidden');
            document.querySelectorAll('[data-connection-workbench-legacy-models]').forEach(node => node.removeAttribute('data-connection-workbench-legacy-models'));
            document.querySelectorAll('[data-cw-model-button]').forEach(node => node.remove());
            refreshCustomConnection();
        },
    };
}

export function getWorkbench() { return active; }
export function cleanup() { active?.cleanup(); active = null; }

// These loaders execute the entry module but do not call manifest hooks.
if (/^SillyTavern:1\.(?:13|14|15|16)\.\d+\b/.test(CLIENT_VERSION)) {
    void init().catch(error => {
        console.error('[Connection Workbench] Initialization failed', error);
        showError(error);
    });
}
