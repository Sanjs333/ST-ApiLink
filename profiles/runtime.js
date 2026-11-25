import { eventSource, saveSettings, saveSettingsDebounced, settings, getRequestHeaders, resultCheckStatus, main_api } from '../../../../../script.js';
import { cancelStatusCheck } from '../compat/status.js';
import { event_types } from '../compat/events.js';
import { extension_settings } from '../../../../extensions.js';
import { oai_settings, proxies, getChatCompletionModel, settingsToUpdate } from '../../../../openai.js';
import { restoreCustomConnection, refreshCustomConnection, bindCustomCredential, connectChatCompletion, supportsNativeCustom, pauseLegacyRequests, assertCustomCompatibility } from '../compat/host.js';
import { SECRET_KEYS, secret_state, readSecretState, rotateSecret, resolveSecretKey } from '../../../../secrets.js';
import { captureCustomFields, normalizeCustomEndpoint, validateCustomSnapshot, CUSTOM_CONNECTION_FIELDS } from '../compat/custom-connection.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommandScope } from '../../../../slash-commands/SlashCommandScope.js';
import { uuidv4, cancelDebounce } from '../../../../utils.js';
import { PROFILE_FIELD, captureMetadata, ensureNoProxyPreset, normalizeMetadata, profileSource, profileProblems, emptyConnectionFields, emptyCustomConnection, connectionDraftValue, draftFingerprint } from './state.js';
import { CUSTOM_MODEL_SOURCES } from '../models/custom.js';
import { rebindProfileSecret } from '../secrets/deduplication.js';
import { createUsageHistory, observeUsageRequests } from './usage.js';
import { readProfileGroups, sameProfileAddress, modelVariant, stableGroupValue } from './groups.js';
import { saveProfileSettings } from './persistence.js';

export function sourceKey(source, fields = {}) {
    if (source === 'vertexai') return fields.vertexai_auth_mode === 'full'
        ? SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT ?? 'vertexai_service_account_json'
        : SECRET_KEYS.VERTEXAI ?? 'api_key_vertexai';
    return SECRET_KEYS[source?.toUpperCase()] ?? null;
}

let profileCommandDepth = 0;
export const isDispatchingProfile = () => profileCommandDepth > 0;
export const command = async (name, value = '', extra = {}) => {
    const callback = SlashCommandParser.commands[name]?.callback;
    if (!callback) throw new Error('请先启用酒馆的 Connection Profiles 扩展。');
    if (name === 'profile') profileCommandDepth++;
    try { return await callback({ _scope: new SlashCommandScope(), _parserFlags: {}, _hasUnnamedArgument: Boolean(value), quiet: 'true', await: 'true', timeout: '0', ...extra }, value); }
    finally { if (name === 'profile') profileCommandDepth--; }
};

/** Optional prompt bindings are owned by each saved model, with absence meaning no binding. */
function normalizeOptionalBindings(profile) {
    const result = structuredClone(profile);
    const excluded = new Set(Array.isArray(result.exclude) ? result.exclude : []);
    for (const key of ['preset', 'reasoning-template']) {
        if (excluded.has(key) || typeof result[key] !== 'string' || !result[key].trim()) {
            delete result[key]; excluded.add(key);
        } else excluded.delete(key);
    }
    result.exclude = [...excluded];
    return result;
}

function indexProfiles(records) {
    const indexed = new Map();
    for (const profile of records) if (!indexed.has(profile.id)) indexed.set(profile.id, profile);
    return indexed;
}

export function createProfileRuntime({ models, onError = console.error, onChange = () => {}, onBeforeSwitch = null }) {
    let disposed = false;
    let authored = false;
    let batchDepth = 0, pendingSync = false;
    let lastApplyError = null;
    let credentialBeforeNone = null;
    let savingGroup = false;
    let draftBaseline = null, switchGuardPromise = null;
    let verifiedCreationDepth = 0;
    let switchingProfileDepth = 0, savingNewConnection = false;
    let switchQueue = Promise.resolve(), pendingSwitches = 0, loadRevision = 0;
    let detachingReasoning = false;
    const listeners = [];
    const profiles = () => extension_settings.connectionManager?.profiles ?? [];
    const selected = () => profiles().find(profile => profile.id === extension_settings.connectionManager?.selectedProfile);
    const groupSettings = () => {
        if (!extension_settings.connectionWorkbench) extension_settings.connectionWorkbench = { version: 1, models: {} };
        return extension_settings.connectionWorkbench;
    };
    const validDraftName = name => typeof name === 'string' && Boolean(name.trim()) && name.trim().length <= 128 && !/[\u0000-\u001f\u007f]/.test(name);
    const restoredDraft = groupSettings().newConnectionDraft;
    let newDraftName = !selected() && restoredDraft?.version === 1 && validDraftName(restoredDraft.name) ? restoredDraft.name.trim() : null;
    const newConnectionName = () => newDraftName;
    const validateNewConnectionName = name => {
        if (!validDraftName(name)) throw new Error('请输入有效的方案名称（最多 128 个字符）。');
        const normalized = name.trim();
        if (profiles().some(profile => typeof profile.name === 'string' && profile.name.trim() === normalized)) throw new Error('此方案名称已存在，请换一个名称。');
        return normalized;
    };
    const setNewConnectionName = name => {
        newDraftName = name;
        if (name === null) delete groupSettings().newConnectionDraft;
        else groupSettings().newConnectionDraft = { version: 1, name };
        saveSettingsDebounced();
    };
    const clearNewConnectionName = () => {
        if (newDraftName !== null || Object.hasOwn(groupSettings(), 'newConnectionDraft')) setNewConnectionName(null);
    };
    let cachedGroupsRaw, cachedProfilesRaw, cachedProfileCount = -1, cachedGroups = [], cachedMembership = new Map();
    const updateGroupCache = () => {
        const raw = groupSettings().groups, records = profiles();
        if (raw === cachedGroupsRaw && records === cachedProfilesRaw && records.length === cachedProfileCount) return;
        cachedGroupsRaw = raw; cachedProfilesRaw = records; cachedProfileCount = records.length;
        cachedGroups = readProfileGroups(groupSettings(), records);
        cachedMembership = new Map(cachedGroups.flatMap(group => group.profileIds.map(id => [id, group])));
    };
    const groups = () => { updateGroupCache(); return cachedGroups.map(group => ({ ...group, profileIds: [...group.profileIds] })); };
    const groupFor = profile => { updateGroupCache(); return cachedMembership.get(typeof profile === 'string' ? profile : profile?.id) ?? null; };
    const writeGroups = value => { groupSettings().groups = value; saveSettingsDebounced(); syncProfileList(); };
    const checkGroupName = (name, id = null) => {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('请输入有效的连接组名称（最多 128 个字符）。');
        if (groups().some(group => group.id !== id && group.name === name.trim())) throw new Error('此连接组名称已存在。');
        return name.trim();
    };
    const groupable = profile => profile?.mode === 'cc' && !profile['custom-connection']?.excluded && !(profile.exclude ?? []).includes('api');
    const groupRecords = ids => {
        if (savingGroup) throw new Error('连接组正在保存，请稍后再试。');
        const indexed = indexProfiles(profiles());
        const entries = [...new Set(ids)].map(id => indexed.get(id));
        if (!entries.length || entries.some(profile => !profile)) throw new Error('请先选择仍然存在的连接方案。');
        if (entries.some(profile => profile.mode !== 'cc')) throw new Error('连接组仅支持聊天补全方案。');
        if (entries.some(profile => !groupable(profile))) throw new Error('此方案继承当前连接，请先保存完整连接再归组。');
        return entries;
    };
    const assignGroup = (ids, groupId) => {
        const entries = groupRecords(ids), list = groups();
        const target = groupId == null ? null : list.find(group => group.id === groupId);
        if (groupId != null && !target) throw new Error('连接组已不存在，请刷新后重试。');
        const targetIds = new Set(target?.profileIds), selectedIds = new Set(ids);
        const members = target ? profiles().filter(profile => targetIds.has(profile.id) && !selectedIds.has(profile.id)) : [];
        const base = members[0] ?? entries[0];
        if (target && [...members, ...entries].some(profile => !sameProfileAddress(base, profile, proxies))) throw new Error('只有地址相同的方案才能归入同一连接组；未填写地址的原生服务按来源和地址设置识别。');
        const moving = new Set(entries.map(profile => profile.id));
        for (const group of list) group.profileIds = group.profileIds.filter(id => !moving.has(id));
        if (target) target.profileIds.push(...moving);
        writeGroups(list);
        return target;
    };
    const createGroup = (name, ids) => {
        name = checkGroupName(name);
        const entries = groupRecords(ids);
        if (entries.some(profile => !sameProfileAddress(entries[0], profile, proxies))) throw new Error('只有地址相同的方案才能创建同一连接组；未填写地址的原生服务按来源和地址设置识别。');
        const list = groups(), moving = new Set(entries.map(profile => profile.id));
        for (const group of list) group.profileIds = group.profileIds.filter(id => !moving.has(id));
        const group = { id: uuidv4(), name, profileIds: [...moving] };
        list.push(group); writeGroups(list); return group;
    };
    const usage = createUsageHistory({ getSettings: () => {
        if (!extension_settings.connectionWorkbench) extension_settings.connectionWorkbench = { version: 1, models: {} };
        return extension_settings.connectionWorkbench;
    }, save: saveSettingsDebounced });
    // Reading an existing selection does not create historical usage.
    const mutationLoads = new Set();
    const mutationTimers = new Set();
    const suppressMutationLoad = profile => {
        if (!profile?.id) return;
        mutationLoads.add(profile.id);
        const timer = setTimeout(() => { mutationLoads.delete(profile.id); mutationTimers.delete(timer); }, 0);
        mutationTimers.add(timer);
    };
    const stopRequestObserver = observeUsageRequests({
        target: typeof window === 'undefined' ? null : window, usage, getVault: () => secret_state,
        resolveSourceKey: sourceKey, baseUrl: typeof window === 'undefined' ? undefined : window.location.href,
    });
    let loadedProfileId = selected()?.id ?? null;
    const noProxyName = () => {
        const { name, created } = ensureNoProxyPreset(proxies);
        const select = document.getElementById('openai_proxy_preset');
        if (select && ![...select.options].some(option => option.value === name)) {
            const previous = select.value;
            select.add(new Option(name, name));
            select.value = previous;
        }
        if (created) saveSettingsDebounced();
        return name;
    };
    const currentCredential = () => {
        if (oai_settings.chat_completion_source === 'custom' && oai_settings.custom_provider_state?.active) {
            const binding = oai_settings.custom_provider_state.active.credential;
            if (binding.mode === 'reference') return { key: binding.key, id: binding.id };
            if (binding.mode === 'legacy-custom' && binding.id) return { key: SECRET_KEYS.CUSTOM, id: binding.id };
            return null;
        }
        // Resolve Vertex from this connection's auth mode; older hosts resolve only the Express key.
        const key = main_api === 'openai' ? sourceKey(oai_settings.chat_completion_source, oai_settings) ?? resolveSecretKey() : resolveSecretKey();
        const id = secret_state[key]?.find(entry => entry.active)?.id;
        return id ? { key, id } : null;
    };
    const currentProxy = () => {
        if (!oai_settings.reverse_proxy) return { mode: 'none' };
        const name = document.getElementById('openai_proxy_preset')?.value;
        return name?.trim() ? { mode: 'preset', name } : { mode: 'inherit' };
    };
    const capture = () => captureMetadata(oai_settings, getChatCompletionModel(), currentProxy(), currentCredential());
    const modelField = source => CUSTOM_MODEL_SOURCES[source]?.field ?? (source === 'custom' ? 'custom_model' : source === 'azure_openai' ? 'azure_openai_model' : null);
    const snapshotDraftSettings = () => {
        const metadata = capture(), field = modelField(metadata.source);
        return structuredClone({ ...metadata.fields, chat_completion_source: metadata.source, ...(field ? { [field]: oai_settings[field] } : {}), reverse_proxy: oai_settings.reverse_proxy, proxy_password: oai_settings.proxy_password, custom_provider_state: oai_settings.custom_provider_state });
    };
    const restoreDraftSettings = previous => {
        Object.assign(oai_settings, structuredClone(previous));
        for (const [field, value] of Object.entries(previous)) {
            const binding = Object.values(settingsToUpdate).find(([, setting]) => setting === field);
            if (binding) {
                if (binding[2]) $(binding[0]).prop('checked', value);
                else $(binding[0]).val(value).trigger('change.select2');
            }
        }
        $('#chat_completion_source').val(previous.chat_completion_source).trigger('change.select2');
        refreshCustomConnection();
        models?.synchronizeSelections?.();
    };
    const connectionFields = () => [...new Set([
        ...Object.values(settingsToUpdate).filter(([, , , connection]) => connection).map(([, field]) => field),
        ...CUSTOM_CONNECTION_FIELDS, ...Object.values(CUSTOM_MODEL_SOURCES).map(config => config.field),
        ...Object.keys(capture().fields), 'chat_completion_source', 'reverse_proxy', 'proxy_password', 'custom_provider_state',
    ])];
    async function snapshotConnection() {
        const api = await command('api');
        const fields = connectionFields();
        return {
            api, fields, settings: structuredClone(Object.fromEntries(fields.filter(field => Object.hasOwn(oai_settings, field)).map(field => [field, oai_settings[field]]))),
            selection: extension_settings.connectionManager?.selectedProfile ?? null, baseline: draftBaseline,
            newName: newDraftName, namedDraft: structuredClone(groupSettings().newConnectionDraft),
            pendingCredential: structuredClone(credentialBeforeNone), details: document.getElementById('connection_profile_details_content')?.innerHTML,
            proxy: document.getElementById('openai_proxy_preset')?.value,
            credentials: Object.entries(secret_state).flatMap(([key, entries]) => {
                const id = Array.isArray(entries) ? entries.find(entry => entry.active)?.id : null;
                return id ? [{ key, id }] : [];
            }),
        };
    }
    async function restoreConnection(previous) {
        loadRevision++;
        cancelStatusCheck('Connection profile rollback');
        try {
            if (await command('api') !== previous.api) await command('api', previous.api, { connect: 'false' });
            for (const { key, id } of previous.credentials) {
                if (secret_state[key]?.some(entry => entry.id === id && entry.active)) continue;
                await rotateSecret(key, id);
                if (!secret_state[key]?.some(entry => entry.id === id && entry.active)) throw new Error('原连接的密钥未能恢复，请重新选择连接方案。');
            }
        } finally {
            for (const field of previous.fields) if (!Object.hasOwn(previous.settings, field)) delete oai_settings[field];
            restoreDraftSettings(previous.settings);
            $('#openai_proxy_preset').val(previous.proxy).trigger('change.select2');
            $('.reverse_proxy_warning').toggle(Boolean(previous.settings.reverse_proxy));
            extension_settings.connectionManager.selectedProfile = previous.selection;
            loadedProfileId = previous.selection;
            draftBaseline = previous.baseline;
            newDraftName = previous.newName;
            credentialBeforeNone = previous.pendingCredential;
            if (previous.namedDraft === undefined) delete groupSettings().newConnectionDraft;
            else groupSettings().newConnectionDraft = previous.namedDraft;
            const details = document.getElementById('connection_profile_details_content');
            if (details && previous.details !== undefined) details.innerHTML = previous.details;
            resultCheckStatus();
            saveSettingsDebounced();
            syncProfileList();
        }
    }
    async function switchConnection(action) {
        const previous = await snapshotConnection();
        switchingProfileDepth++;
        const releaseLegacy = pauseLegacyRequests();
        try { return await action(); }
        catch (error) {
            try { await restoreConnection(previous); }
            catch (rollbackError) {
                extension_settings.connectionManager.selectedProfile = null;
                loadedProfileId = null;
                draftBaseline = null;
                saveSettingsDebounced(); syncProfileList();
                throw new AggregateError([error, rollbackError], error.message + '；' + rollbackError.message);
            }
            throw error;
        } finally { switchingProfileDepth--; releaseLegacy(); }
    }
    function enqueueSwitch(action) {
        // Keep native loading, extra fields and rollback in one queue, including clearing a profile.
        pendingSwitches++;
        const operation = switchQueue.catch(() => {}).then(() => disposed ? false : action());
        switchQueue = operation;
        onChange();
        return operation.finally(() => { pendingSwitches--; onChange(); });
    }
    const prepareDraftProxy = label => {
        const url = oai_settings.reverse_proxy ?? '', password = oai_settings.proxy_password ?? '';
        if (!url.trim()) {
            if (password) throw new Error('请先填写代理地址，或清空代理密码后再保存。');
            return { proxy: { mode: 'none' }, created: null, expected: null };
        }
        let parsed;
        try { parsed = new URL(url); } catch { throw new Error('请填写有效的 HTTP(S) 代理地址后再保存。'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写不含账号和密码的 HTTP(S) 代理地址。');
        const node = document.getElementById('openai_proxy_preset');
        let preset = proxies.find(entry => entry.name === node?.value && entry.name?.trim() && entry.url === url && entry.password === password)
            ?? proxies.find(entry => entry.name?.trim() && entry.url === url && entry.password === password);
        let created = null;
        if (!preset) {
            const base = String(label).slice(0, 100) + ' · 代理';
            let name = base;
            for (let n = 2; proxies.some(entry => entry.name === name); n++) name = base + ' ' + n;
            preset = { name, url, password }; proxies.push(preset); created = preset;
        }
        return { proxy: { mode: 'preset', name: preset.name }, expected: structuredClone(preset), created, node, previousValue: node?.value };
    };
    const projectDraftProxy = plan => {
        if (!plan?.node || plan.proxy.mode !== 'preset') return;
        if (![...plan.node.options].some(option => option.value === plan.proxy.name)) plan.node.add(new Option(plan.proxy.name, plan.proxy.name));
        plan.node.value = plan.proxy.name;
    };
    const rollbackDraftProxy = plan => {
        if (plan?.created) {
            const index = proxies.indexOf(plan.created);
            if (index >= 0) proxies.splice(index, 1);
            const option = [...(plan.node?.options ?? [])].find(entry => entry.value === plan.created.name);
            option?.remove();
        }
        if (plan?.node) plan.node.value = plan.previousValue;
    };
    const captureDraft = () => draftFingerprint(connectionDraftValue({ mainApi: main_api, metadata: capture(), reverseProxy: oai_settings.reverse_proxy, proxyPassword: oai_settings.proxy_password, customState: oai_settings.custom_provider_state?.active }));
    const markClean = () => { try { draftBaseline = captureDraft(); } catch { draftBaseline = null; } };
    const hasUnsavedChanges = () => { try { return newDraftName !== null || draftBaseline !== captureDraft(); } catch { return true; } };
    markClean();
    async function allowSwitch(target, skip) {
        if (skip) return true;
        if (switchGuardPromise) return false;
        if (!hasUnsavedChanges() || typeof onBeforeSwitch !== 'function') return true;
        const current = selected() ?? null;
        switchGuardPromise = Promise.resolve().then(() => onBeforeSwitch({ current, target }));
        try { return await switchGuardPromise === true; }
        finally { switchGuardPromise = null; }
    }
    const isNoKey = () => {
        const credential = oai_settings.custom_provider_state?.active?.credential;
        return main_api === 'openai' && oai_settings.chat_completion_source === 'custom'
            && (credential?.mode === 'none' || credential?.mode === 'legacy-custom' && credential.id === null);
    };
    const keyContext = () => {
        let endpoint = null;
        try { endpoint = normalizeCustomEndpoint(oai_settings.custom_url); } catch { /* An incomplete root cannot approve restoration. */ }
        const active = oai_settings.custom_provider_state?.active;
        return { mainApi: main_api, source: oai_settings.chat_completion_source, endpoint,
            provider: active?.provider?.id ?? null, profile: selected()?.id ?? null,
            auth: JSON.stringify(active?.auth ?? { mode: 'bearer', required: false }) };
    };
    function customBase() {
        if (main_api !== 'openai' || oai_settings.chat_completion_source !== 'custom') throw new Error('请先切换到 Custom 连接，再设置是否使用密钥。');
        const state = oai_settings.custom_provider_state;
        if (state && state.version !== 1) throw new Error('此连接格式暂不支持，请保留原配置。');
        return state?.active ?? { provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false } };
    }
    function applyCustomCredential(credential) {
        const state = oai_settings.custom_provider_state;
        const base = customBase();
        const snapshot = validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...base, credential });
        const oldCredential = state?.active?.credential;
        let released = false;
        if (state?.active) {
            try { validateCustomSnapshot({ version: 1, settings: snapshot.settings, ...base }); }
            catch {
                // Validate the edited result first; an obsolete root binding must not block an explicit no-key choice.
                state.active.credential = credential; released = true;
            }
        }
        try { restoreCustomConnection(snapshot); }
        catch (error) { if (released && state?.active === base) state.active.credential = oldCredential; throw error; }
        onChange();
    }
    function enableNoKey() {
        const base = customBase();
        if (base.auth.required) throw new Error('此服务提供商要求密钥。');
        if (isNoKey()) return { enabled: true, restored: false, message: '当前连接不发送密钥' };
        const previous = { context: keyContext(), credential: structuredClone(base.credential ?? {
            mode: 'legacy-custom', id: secret_state[SECRET_KEYS.CUSTOM]?.find(entry => entry.active)?.id ?? null,
        }) };
        applyCustomCredential({ mode: 'none' });
        credentialBeforeNone = previous;
        return { enabled: true, restored: false, message: '当前连接不发送密钥' };
    }
    function toggleNoKey() {
        if (!isNoKey()) return enableNoKey();
        const base = customBase();
        if (base.auth.mode === 'none') throw new Error('此服务固定不使用密钥，不能切换为带密钥的连接。');
        const previous = credentialBeforeNone;
        const context = keyContext();
        let credential = { mode: 'unbound' };
        let message = '已取消不使用密钥，请重新选择密钥';
        if (previous) {
            const sameConnection = previous.context.mainApi === context.mainApi && previous.context.source === context.source
                && previous.context.provider === context.provider && previous.context.profile === context.profile
                && previous.context.auth === context.auth;
            const sameRoot = Boolean(context.endpoint) && previous.context.endpoint === context.endpoint;
            const candidate = previous.credential;
            if (!sameConnection) message = '连接已切换，已取消免密，请为当前连接重新选择密钥';
            else if (!sameRoot) message = 'API 地址已变更，已取消免密，请为新地址重新选择密钥';
            else {
                const key = candidate?.mode === 'reference' ? candidate.key : candidate?.mode === 'legacy-custom' ? SECRET_KEYS.CUSTOM : null;
                if (key && candidate.id) {
                    if (secret_state[key]?.some(entry => entry.id === candidate.id)) {
                        try {
                            validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...base, credential: candidate });
                            credential = candidate; message = '已取消不使用密钥，恢复之前选择的密钥';
                        } catch { message = '之前的密钥地址绑定已失效，已取消免密，请重新选择密钥'; }
                    }
                    else message = '之前的密钥已删除，已取消免密，请重新选择密钥';
                }
            }
        }
        applyCustomCredential(credential);
        credentialBeforeNone = null;
        return { enabled: false, restored: credential.mode !== 'unbound', message };
    }

    function syncProfileList(plain = false) {
        if (batchDepth) { pendingSync = true; return; }
        pendingSync = false;
        const select = document.getElementById('connection_profiles');
        if (select) {
            const entries = [...profiles()].sort((a, b) => a.name.localeCompare(b.name));
            const grouped = plain ? [] : groups();
            const nodes = [new Option('未选择方案', '')];
            const byId = new Map(entries.map(profile => [profile.id, profile]));
            const memberIds = new Set(grouped.flatMap(group => group.profileIds));
            for (const group of grouped) {
                const members = group.profileIds.map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
                if (!members.length) continue;
                const node = document.createElement('optgroup');
                node.label = group.name;
                node.dataset.cwConnectionGroup = group.id;
                node.append(...members.map(profile => new Option(profile.name, profile.id)));
                nodes.push(node);
            }
            nodes.push(...entries.filter(profile => !memberIds.has(profile.id)).map(profile => new Option(profile.name, profile.id)));
            select.replaceChildren(...nodes);
            select.value = extension_settings.connectionManager.selectedProfile ?? '';
        }
        onChange();
    }

    const replaceProfile = (profile, value) => {
        for (const key of Object.keys(profile)) if (!Object.hasOwn(value, key)) delete profile[key];
        Object.assign(profile, structuredClone(value));
    };

    async function verifySavedProfiles(expected, expectedProxy = null, expectedGroups = null) {
        await saveProfileSettings({ save: saveSettings, cancelPending: () => cancelDebounce(saveSettingsDebounced),
            events: eventSource, savedEvent: event_types.SETTINGS_UPDATED, getSavedSettings: () => settings,
            expectedProfiles: expected, expectedProxy, expectedGroups });
    }

    async function saveGroupMembership(profile, previous, next, expectedProxy = null) {
        const group = groupFor(profile);
        if (!group || groupable(next) && sameProfileAddress(previous, next, proxies)) return false;
        if (savingGroup) throw new Error('连接组正在保存，请稍后再试。');
        const oldGroups = structuredClone(groupSettings().groups ?? []);
        groupSettings().groups = groups().map(entry => ({ ...entry, profileIds: entry.profileIds.filter(id => id !== profile.id) }));
        savingGroup = true;
        try {
            replaceProfile(profile, next);
            await verifySavedProfiles([next], expectedProxy, groupSettings().groups);
        } catch (error) {
            replaceProfile(profile, previous);
            groupSettings().groups = oldGroups;
            saveSettingsDebounced();
            throw error;
        } finally {
            savingGroup = false;
        }
        authored = true;
        try { await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, previous, profile); }
        finally { authored = false; }
        syncProfileList();
        return true;
    }

    function attach(profile, { fresh = false, bindingSource = profile } = {}) {
        if (profile.mode !== 'cc' || main_api !== 'openai') return;
        const excluded = new Set((Array.isArray(profile.exclude) ? profile.exclude : []).filter(key => !['preset', 'reasoning-template'].includes(key)));
        for (const key of ['preset', 'reasoning-template']) {
            if (!fresh && !(Array.isArray(bindingSource.exclude) && bindingSource.exclude.includes(key)) && typeof bindingSource[key] === 'string' && bindingSource[key].trim()) {
                profile[key] = bindingSource[key];
            } else { delete profile[key]; excluded.add(key); }
        }
        profile.exclude = [...excluded];
        profile[PROFILE_FIELD] = capture();
        if (!supportsNativeCustom && oai_settings.chat_completion_source === 'custom') {
            const active = oai_settings.custom_provider_state?.active;
            profile['custom-connection'] = validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...active });
            profile['api-url'] = profile['custom-connection'].settings.custom_url;
            profile['prompt-post-processing'] = profile['custom-connection'].settings.custom_prompt_post_processing;
            const credential = profile['custom-connection'].credential;
            if (credential.mode === 'reference' || credential.mode === 'legacy-custom' && credential.id) profile['secret-id'] = credential.id;
            else delete profile['secret-id'];
        }
        if (profile.exclude?.includes('proxy')) profile[PROFILE_FIELD].proxy = { mode: 'inherit' };
        else if (profile[PROFILE_FIELD].proxy.mode === 'none') profile.proxy = noProxyName();
        else if (profile[PROFILE_FIELD].proxy.mode === 'preset') profile.proxy = profile[PROFILE_FIELD].proxy.name;
        // Vertex's auth mode belongs to this connection and is restored before selecting its vault category.
        if (oai_settings.chat_completion_source === 'vertexai') delete profile['secret-id'];
        saveSettingsDebounced();
    }

    async function applyExtras(profile, isCurrent = () => !disposed) {
        if (!profile || !isCurrent()) return;
        if (profile['custom-connection']?.excluded) return;
        if (!profile[PROFILE_FIELD]) {
            if (!supportsNativeCustom && profile['custom-connection']) restoreCustomConnection(profile['custom-connection']);
            return;
        }
        const metadata = normalizeMetadata(profile[PROFILE_FIELD]);
        // A complete Custom snapshot owns the endpoint, model and authentication together.
        // Older duplicated workbench fields must not replace part of that saved connection.
        if (metadata.source === 'custom' && profile['custom-connection']) {
            const snapshot = validateCustomSnapshot(profile['custom-connection']);
            metadata.fields = { ...snapshot.settings };
            metadata.model = snapshot.settings.custom_model;
            const credential = snapshot.credential;
            metadata.credential = credential.mode === 'reference' ? { key: credential.key, id: credential.id }
                : credential.mode === 'legacy-custom' && credential.id ? { key: SECRET_KEYS.CUSTOM, id: credential.id } : null;
        }
        if (!supportsNativeCustom && metadata.source === 'custom') {
            const snapshot = profile['custom-connection'] ?? {
                version: 1, settings: captureCustomFields(metadata.fields, true),
                provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false },
                credential: metadata.credential
                    ? { mode: 'reference', ...metadata.credential, endpoint: normalizeCustomEndpoint(metadata.fields.custom_url) }
                    : { mode: 'legacy-custom', id: profile['secret-id'] ?? null },
            };
            restoreCustomConnection(snapshot);
            if (snapshot.credential.mode === 'reference' || snapshot.credential.mode === 'legacy-custom' && snapshot.credential.id) {
                const release = pauseLegacyRequests();
                try {
                    if (!secret_state[SECRET_KEYS.CUSTOM]?.some(entry => entry.id === snapshot.credential.id && entry.active)) await rotateSecret(SECRET_KEYS.CUSTOM, snapshot.credential.id);
                }
                finally { release(); }
                if (!isCurrent()) return;
                if (!secret_state[SECRET_KEYS.CUSTOM]?.some(entry => entry.id === snapshot.credential.id && entry.active)) throw new Error('密钥未能切换，请重试。');
            }
        }
        if (oai_settings.chat_completion_source !== metadata.source) throw new Error('此方案的 API 来源没有正确切换，请编辑方案重新保存。');
        if (metadata.credential && !secret_state[metadata.credential.key]?.some(entry => entry.id === metadata.credential.id)) throw new Error('此方案保存的密钥已删除，请在“管理方案”里重新选择。');
        if (metadata.source !== 'custom' && metadata.credential && metadata.credential.key !== sourceKey(metadata.source, metadata.fields)) throw new Error('此方案的密钥分类与 API 来源或认证方式不同，请重新选择。');
        for (const [field, value] of Object.entries(metadata.fields)) {
            oai_settings[field] = value;
            const binding = Object.values(settingsToUpdate).find(([, setting]) => setting === field);
            if (binding) $(binding[0]).val(value);
        }
        if (metadata.source === 'vertexai') $('#vertexai_auth_mode').trigger('change');
        if (metadata.source !== 'custom' && metadata.credential) {
            if (!secret_state[metadata.credential.key]?.some(entry => entry.id === metadata.credential.id && entry.active)) await rotateSecret(metadata.credential.key, metadata.credential.id);
            if (!isCurrent()) return;
            if (!secret_state[metadata.credential.key]?.some(entry => entry.id === metadata.credential.id && entry.active)) throw new Error('密钥未能切换，请重试。');
        }
        const field = modelField(metadata.source);
        if (field) {
            oai_settings[field] = metadata.model;
            const binding = Object.values(settingsToUpdate).find(([, setting]) => setting === field);
            if (binding) $(binding[0]).val(metadata.model);
        }
        if (models && Object.hasOwn(CUSTOM_MODEL_SOURCES, metadata.source) && metadata.model && models.list(metadata.source).some(entry => entry.id === metadata.model)) models.select(metadata.source, metadata.model);
        if (metadata.proxy.mode === 'none') {
            await command('proxy', noProxyName());
            if (!isCurrent()) return;
            // Preserve the direct connection even if another listener rewrites native fields.
            oai_settings.reverse_proxy = '';
            oai_settings.proxy_password = '';
            $('#openai_reverse_proxy').val('');
            $('#openai_proxy_access_key').val('');
            $('.reverse_proxy_warning').toggle(false);
        }
        if (metadata.proxy.mode === 'preset') {
            const option = [...(document.getElementById('openai_proxy_preset')?.options ?? [])].find(entry => entry.value === metadata.proxy.name);
            if (!option) throw new Error('此方案的代理预设已不存在，请重新选择代理。');
            await command('proxy', metadata.proxy.name);
            if (!isCurrent()) return;
        }
        refreshCustomConnection();
        saveSettingsDebounced();
    }

    function clearCurrentConnection() {
        credentialBeforeNone = null;
        if (main_api !== 'openai') return;
        const source = oai_settings.chat_completion_source;
        if (Object.hasOwn(CUSTOM_MODEL_SOURCES, source)) models?.clearSelection?.(source);
        if (source === 'custom') {
            const active = oai_settings.custom_provider_state?.active;
            if (active?.credential?.mode === 'reference') {
                // Clearing an edited root must also work when its previous approval has expired.
                try { validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...active }); }
                catch { active.credential = { mode: active.auth?.mode === 'none' ? 'none' : 'unbound' }; }
            }
            restoreCustomConnection(emptyCustomConnection(), 'profile cleared');
        }
        for (const [field, value] of Object.entries(emptyConnectionFields(source, CUSTOM_MODEL_SOURCES))) {
            oai_settings[field] = value;
            const binding = Object.values(settingsToUpdate).find(([, setting]) => setting === field);
            if (binding) $(binding[0]).val(value).trigger('change.select2');
        }
        $('#openai_proxy_preset').val(noProxyName()).trigger('change');
        $('.reverse_proxy_warning').toggle(false);
        if (source === 'vertexai') $('#vertexai_auth_mode').trigger('change');
        const key = sourceKey(source, oai_settings);
        if (key) $(key === SECRET_KEYS.OPENROUTER ? '.api_key_openrouter' : '#' + key).val('');
        if (source === 'vertexai') $('#vertexai_service_account_json').val('');
        refreshCustomConnection();
        cancelStatusCheck('Connection profile cleared');
        resultCheckStatus();
        saveSettingsDebounced();
    }

    function listen(type, handler) {
        if (!type) return;
        const wrapped = async (...args) => {
            try { await handler(...args); }
            catch (error) {
                // A runtime switch reports its own failure after restoring the previous connection.
                if (type !== event_types.CONNECTION_PROFILE_LOADED || !switchingProfileDepth) onError(error);
            }
        };
        eventSource.on(type, wrapped);
        listeners.push(() => eventSource.removeListener(type, wrapped));
    }
    listen(event_types.CONNECTION_PROFILE_CREATED, profile => {
        suppressMutationLoad(profile);
        if (!authored) {
            attach(profile, { fresh: true });
            if (!verifiedCreationDepth && profile?.id === selected()?.id) { clearNewConnectionName(); markClean(); }
        }
        syncProfileList();
    });
    listen(event_types.CONNECTION_PROFILE_UPDATED, async (_old, profile) => {
        suppressMutationLoad(profile);
        if (authored) { pendingSync = true; return; }
        if (!authored && profile?.id === selected()?.id) attach(profile, { bindingSource: _old ?? profile });
        if (!authored && _old && await saveGroupMembership(profile, _old, structuredClone(profile))) {
            if (profile?.id === selected()?.id) markClean();
            return;
        }
        if (profile?.id === selected()?.id) markClean();
        syncProfileList();
    });
    listen(event_types.CONNECTION_PROFILE_DELETED, () => { usage.prune(profiles(), secret_state); syncProfileList(); });
    listen(event_types.CONNECTION_PROFILE_LOADED, async name => {
        const current = selected();
        if (typeof name === 'string' && name !== (current?.name ?? '<None>')) return;
        const profile = current ? structuredClone(current) : null;
        const revision = ++loadRevision;
        const isCurrent = () => !disposed && revision === loadRevision && (selected()?.id ?? null) === (profile?.id ?? null);
        const mutationLoad = Boolean(profile && mutationLoads.delete(profile.id));
        const clear = Boolean(loadedProfileId && !profile && !extension_settings.connectionManager?.selectedProfile);
        loadedProfileId = profile?.id ?? null;
        // Saving the current draft as a new record already has the desired live state.
        if (verifiedCreationDepth) { onChange(); return; }
        try {
            if (clear) clearCurrentConnection();
            else await applyExtras(profile, isCurrent);
        }
        catch (error) { lastApplyError = { id: profile?.id, error }; throw error; }
        if (!isCurrent()) return;
        if (profile && !switchingProfileDepth) clearNewConnectionName();
        if (!switchingProfileDepth) markClean();
        if (profile && !mutationLoad && !switchingProfileDepth) usage.recordProfile(profile.id);
        onChange();
    });
    for (const type of [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_EDITED, event_types.SECRET_ROTATED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CUSTOM_CONNECTION_CHANGED]) listen(type, () => {
        if (!isNoKey()) credentialBeforeNone = null;
        onChange();
    });
    listen(event_types.SECRET_DELETED, () => usage.prune(profiles(), secret_state));

    function validate(profile) {
        if (profile['custom-connection'] && !profile['custom-connection'].excluded) assertCustomCompatibility(validateCustomSnapshot(profile['custom-connection']));
        const problems = profileProblems(profile, secret_state, sourceKey(profileSource(profile), profile[PROFILE_FIELD]?.fields));
        if (problems.some(problem => !problem.includes('继承'))) throw new Error(problems.join('；') + '。请先编辑修复此方案。');
        const metadata = profile[PROFILE_FIELD] ? normalizeMetadata(profile[PROFILE_FIELD]) : null;
        if (metadata?.source !== 'custom' && metadata?.credential && metadata.credential.key !== sourceKey(metadata.source, metadata.fields)) throw new Error('此方案密钥分类不匹配，请编辑修复。');
        if (metadata?.proxy.mode === 'preset' && ![...(document.getElementById('openai_proxy_preset')?.options ?? [])].some(option => option.value === metadata.proxy.name)) throw new Error('此方案的代理预设已不存在，请编辑修复。');
        if (metadata?.proxy.mode === 'none') {
            const name = noProxyName();
            if (profile.proxy !== name || profile.exclude?.includes('proxy')) {
                profile.proxy = name;
                profile.exclude = (profile.exclude ?? []).filter(field => field !== 'proxy');
                saveSettingsDebounced();
            }
        }
    }
    const runtime = {
        profiles, selected, capture, currentCredential, currentProxy, noProxyName, syncProfileList, isNoKey, keyContext, toggleNoKey, usage,
        groups, groupFor, createGroup, assignGroup,
        hasUnsavedChanges, newConnectionName, validateNewConnectionName, isSwitching: () => pendingSwitches > 0,
        groupCandidates(profile) {
            const base = typeof profile === 'string' ? profiles().find(entry => entry.id === profile) : profile;
            if (!groupable(base)) return [];
            return profiles().filter(entry => entry.id !== base.id && groupable(entry) && !groupFor(entry) && sameProfileAddress(base, entry, proxies));
        },
        renameGroup(id, name) {
            if (savingGroup) throw new Error('连接组正在保存，请稍后再试。');
            const list = groups(), group = list.find(entry => entry.id === id);
            if (!group) throw new Error('连接组已不存在。');
            group.name = checkGroupName(name, id); writeGroups(list); return group;
        },
        removeGroup(id) {
            if (savingGroup) throw new Error('连接组正在保存，请稍后再试。');
            writeGroups(groups().filter(group => group.id !== id));
        },
        async batch(action) {
            batchDepth++;
            try { return await action(); }
            finally { batchDepth--; if (!batchDepth && pendingSync) { pendingSync = false; syncProfileList(); } }
        },
        validate,
        problems: profile => profileProblems(profile, secret_state, sourceKey(profileSource(profile), profile[PROFILE_FIELD]?.fields)),
        async create(name, { verifyPersistence = false } = {}) {
            if (main_api !== 'openai') throw new Error('请先选择聊天补全，再保存连接方案。');
            if (!name.trim() || profiles().some(profile => profile.name === name.trim())) throw new Error('请输入未使用的方案名称。');
            const previousSelection = extension_settings.connectionManager?.selectedProfile ?? null;
            const previousBaseline = draftBaseline;
            const previousNewName = newDraftName;
            const previousNamedDraft = structuredClone(groupSettings().newConnectionDraft);
            const previousDraft = verifyPersistence ? snapshotDraftSettings() : null;
            const proxyPlan = verifyPersistence ? prepareDraftProxy(name.trim()) : null;
            const originalIds = new Set(profiles().map(profile => profile.id));
            let profile;
            if (verifyPersistence) verifiedCreationDepth++;
            try {
                projectDraftProxy(proxyPlan);
                await command('profile-create', name.trim());
                profile = selected();
                if (!profile || originalIds.has(profile.id)) throw new Error('未能创建连接方案。');
                attach(profile, { fresh: true });
                if (proxyPlan) {
                    profile[PROFILE_FIELD].proxy = proxyPlan.proxy;
                    if (proxyPlan.proxy.mode === 'preset') profile.proxy = proxyPlan.proxy.name;
                    profile.exclude = (profile.exclude ?? []).filter(field => field !== 'proxy');
                }
                clearNewConnectionName();
                if (verifyPersistence) await verifySavedProfiles([structuredClone(profile)], proxyPlan.expected);
            } catch (error) {
                if (verifyPersistence) {
                    const created = profile && !originalIds.has(profile.id) ? profile : profiles().find(entry => !originalIds.has(entry.id) && entry.name === name.trim());
                    const index = created ? profiles().findIndex(entry => entry.id === created.id) : -1;
                    if (index >= 0) profiles().splice(index, 1);
                    extension_settings.connectionManager.selectedProfile = previousSelection;
                    loadedProfileId = previousSelection;
                    rollbackDraftProxy(proxyPlan);
                    restoreDraftSettings(previousDraft);
                    draftBaseline = previousBaseline;
                    newDraftName = previousNewName;
                    if (previousNamedDraft === undefined) delete groupSettings().newConnectionDraft;
                    else groupSettings().newConnectionDraft = previousNamedDraft;
                    saveSettingsDebounced(); syncProfileList();
                }
                throw error;
            } finally { if (verifyPersistence) verifiedCreationDepth--; }
            markClean();
            syncProfileList();
            return profile;
        },
        createFromCurrent(name) { return runtime.create(name, { verifyPersistence: true }); },
        async saveNewConnection() {
            if (savingNewConnection) throw new Error('新连接方案正在保存，请稍后再试。');
            const name = validateNewConnectionName(newDraftName);
            if (selected()) throw new Error('当前已有选中的连接方案，请另存为新方案。');
            if (main_api !== 'openai') throw new Error('请先选择聊天补全，再保存连接方案。');
            const model = getChatCompletionModel();
            if (typeof model !== 'string' || !model.trim() || model.trim().length > 512 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('请输入有效的模型 ID（最多 512 个字符）。');
            if (oai_settings.chat_completion_source === 'custom') {
                try { normalizeCustomEndpoint(oai_settings.custom_url); }
                catch { throw new Error('请先填写有效的 Custom API 地址。'); }
                const snapshot = validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...customBase() });
                if (!['reference', 'none'].includes(snapshot.credential.mode)) throw new Error('请选择密钥，或明确选择不使用密钥。');
                if (snapshot.credential.mode === 'reference' && !secret_state[snapshot.credential.key]?.some(entry => entry.id === snapshot.credential.id)) throw new Error('所选密钥已不存在，请重新选择。');
            }
            const savingDraft = captureDraft();
            savingNewConnection = true;
            try {
                const profile = await runtime.createFromCurrent(name);
                draftBaseline = savingDraft;
                onChange();
                if (hasUnsavedChanges()) throw new Error('新方案已保存，但保存期间连接设置又发生了变化，请检查新的修改。');
                return profile;
            }
            finally { savingNewConnection = false; }
        },
        /** Save the editor's complete tuple independently of the live connection and selected profile. */
        async createConfigured(updated) {
            if (!extension_settings.connectionManager || !Array.isArray(extension_settings.connectionManager.profiles)) throw new Error('请先启用酒馆的 Connection Profiles 扩展。');
            if (typeof updated?.name !== 'string' || !updated.name.trim() || updated.name.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(updated.name)
                || profiles().some(entry => entry.name === updated.name.trim())) throw new Error('请输入未使用的方案名称（最多 128 个字符）。');
            if (typeof updated.model !== 'string' || !updated.model.trim() || updated.model.trim().length > 512 || /[\u0000-\u001f\u007f]/.test(updated.model)) throw new Error('请输入有效的模型 ID（最多 512 个字符）。');
            const next = normalizeOptionalBindings(updated);
            next.id = uuidv4(); next.name = next.name.trim(); next.model = next.model.trim(); next.mode = 'cc';
            const metadata = normalizeMetadata(next[PROFILE_FIELD]);
            if (!['custom', 'azure_openai'].includes(metadata.source) && !Object.hasOwn(CUSTOM_MODEL_SOURCES, metadata.source)) throw new Error('请选择支持的 API 来源。');
            metadata.model = next.model;
            next[PROFILE_FIELD] = metadata;
            next.api = metadata.source === 'makersuite' ? 'google' : metadata.source;
            if (metadata.source === 'custom') {
                next['custom-connection'] = validateCustomSnapshot(next['custom-connection']);
                if (!['reference', 'none'].includes(next['custom-connection'].credential.mode)) throw new Error('请选择密钥，或明确选择不使用密钥。');
                next['custom-connection'].settings.custom_url = normalizeCustomEndpoint(next['custom-connection'].settings.custom_url);
                next['custom-connection'].settings.custom_model = next.model;
                next['api-url'] = next['custom-connection'].settings.custom_url;
                metadata.fields = { ...next['custom-connection'].settings };
            } else { delete next['custom-connection']; delete next['api-url']; }
            const originalProxyNames = new Set(proxies.map(preset => preset.name));
            next.exclude = [...new Set([...(next.exclude ?? []), 'stop-strings', 'start-reply-with', 'regex-preset'])];
            let added = false;
            try {
                if (metadata.proxy.mode === 'none') {
                    next.proxy = noProxyName();
                    next.exclude = next.exclude.filter(field => field !== 'proxy');
                } else if (metadata.proxy.mode === 'preset') next.proxy = metadata.proxy.name;
                else { delete next.proxy; next.exclude.push('proxy'); }
                validate(next);
                profiles().push(next); added = true;
                await verifySavedProfiles([structuredClone(next)]);
            } catch (error) {
                if (added) {
                    const index = profiles().findIndex(profile => profile.id === next.id);
                    if (index >= 0) profiles().splice(index, 1);
                }
                for (let index = proxies.length - 1; index >= 0; index--) {
                    const preset = proxies[index];
                    if (originalProxyNames.has(preset.name) || preset.name !== next.proxy || preset.url || preset.password || profiles().some(profile => profile.proxy === preset.name)) continue;
                    proxies.splice(index, 1);
                    for (const option of [...(document.getElementById('openai_proxy_preset')?.options ?? [])]) if (option.value === preset.name) option.remove();
                }
                if (added) saveSettingsDebounced();
                syncProfileList();
                throw error;
            }
            const snapshot = structuredClone(next);
            authored = true;
            try { await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, next); }
            catch (error) { try { onError(error); } catch { /* A listener cannot undo a verified save. */ } }
            finally {
                authored = false;
                // Listeners that capture the active connection must not replace this form's saved settings.
                if (stableGroupValue(next) !== stableGroupValue(snapshot)) { replaceProfile(next, snapshot); saveSettingsDebounced(); }
            }
            if (models && Object.hasOwn(CUSTOM_MODEL_SOURCES, metadata.source)) {
                try { models.ensureOption(metadata.source, next.model); }
                catch (error) { try { onError(error); } catch { /* The saved connection remains available for a retry. */ } }
            }
            syncProfileList();
            return next;
        },
        async update() {
            if (!selected()) throw new Error('请先选择一个方案。');
            const bindingSource = structuredClone(selected());
            await command('profile-update');
            attach(selected(), { bindingSource });
            syncProfileList();
        },
        async select(profile, { skipUnsavedCheck = false } = {}) {
            profile = profiles().find(entry => entry.id === profile?.id);
            if (!profile) throw new Error('此连接方案已不存在，请重新选择。');
            if (!skipUnsavedCheck && selected()?.id === profile.id) return true;
            if (!await allowSwitch(profile, skipUnsavedCheck)) return false;
            validate(profile);
            mutationLoads.delete(profile.id);
            if (models && Object.hasOwn(CUSTOM_MODEL_SOURCES, profileSource(profile)) && profile.model && models.list(profileSource(profile)).some(entry => entry.id === profile.model)) models.ensureOption(profileSource(profile), profile.model);
            return switchConnection(async () => {
                const oldCredential = oai_settings.custom_provider_state?.active?.credential;
                if (oldCredential?.mode === 'reference' && !profile['custom-connection']?.excluded) {
                    const base = oai_settings.custom_provider_state.active;
                    try { validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...base }); }
                    catch (error) {
                        if (!/exact API root/.test(error.message)) throw error;
                        validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...base, credential: { mode: 'unbound' } });
                        base.credential = { mode: 'unbound' };
                    }
                }
                lastApplyError = null;
                cancelStatusCheck('Switching connection profile');
                await command('profile', profile.name);
                if (lastApplyError?.id === profile.id) throw lastApplyError.error;
                if (selected()?.id !== profile.id) throw new Error('方案未能加载，请检查它保存的来源和密钥。');
                if (!supportsNativeCustom) await connectChatCompletion();
                clearNewConnectionName();
                markClean();
                usage.recordProfile(profile.id);
                onChange();
                return true;
            });
        },
        async deselect({ skipUnsavedCheck = false } = {}) {
            if (!selected()) return true;
            if (!await allowSwitch(null, skipUnsavedCheck)) return false;
            return switchConnection(async () => {
                lastApplyError = null;
                await command('profile', '<None>');
                if (lastApplyError) throw lastApplyError.error;
                if (selected()) throw new Error('未能退出当前方案，请重试。');
                markClean();
                onChange();
                return true;
            });
        },
        async startNewConnection({ name, skipUnsavedCheck = false } = {}) {
            const pendingName = name === undefined ? null : validateNewConnectionName(name);
            if (main_api !== 'openai') throw new Error('请先切换到聊天补全，再新建空白连接。');
            if (!await allowSwitch(null, skipUnsavedCheck)) return false;
            if (pendingName !== null) validateNewConnectionName(pendingName);
            if (selected()) {
                if (!await deselectConnection({ skipUnsavedCheck: true })) return false;
            } else clearCurrentConnection();
            setNewConnectionName(pendingName);
            markClean();
            onChange();
            return true;
        },
        async saveCurrentToSelected() {
            const profile = selected();
            if (!profile) throw new Error('当前没有已保存的连接方案，请另存为新方案。');
            if (main_api !== 'openai' || profile.mode !== 'cc') throw new Error('请使用聊天补全连接保存当前修改。');
            const savingDraft = captureDraft();
            const metadata = capture();
            const next = structuredClone(profile);
            next.api = metadata.source === 'makersuite' ? 'google' : metadata.source;
            next.mode = 'cc'; next.model = metadata.model; next[PROFILE_FIELD] = metadata;
            next.exclude = (next.exclude ?? []).filter(field => !['api', 'model', 'api-url', 'proxy', 'secret-id', 'custom-connection', 'prompt-post-processing'].includes(field));
            if (metadata.source === 'custom') {
                const active = oai_settings.custom_provider_state?.active ?? { provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false }, credential: { mode: 'legacy-custom', id: metadata.credential?.id ?? null } };
                next['custom-connection'] = validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), provider: active.provider, models: active.models, auth: active.auth, credential: active.credential });
                next['api-url'] = metadata.fields.custom_url;
                next['prompt-post-processing'] = metadata.fields.custom_prompt_post_processing;
            } else { delete next['custom-connection']; delete next['api-url']; }
            if (metadata.credential && metadata.source !== 'vertexai' && metadata.credential.key === sourceKey(metadata.source, metadata.fields)) next['secret-id'] = metadata.credential.id;
            else delete next['secret-id'];
            const proxyPlan = prepareDraftProxy(profile.name);
            metadata.proxy = proxyPlan.proxy;
            next.proxy = metadata.proxy.mode === 'none' ? noProxyName() : metadata.proxy.name;
            try { await runtime.save(profile, next, { verifyPersistence: true, expectedProxy: proxyPlan.expected }); }
            catch (error) { rollbackDraftProxy(proxyPlan); throw error; }
            draftBaseline = savingDraft;
            if (hasUnsavedChanges()) throw new Error('保存期间连接设置又发生了变化，请先处理新的修改。');
            projectDraftProxy(proxyPlan);
            markClean();
            onChange();
            return profile;
        },
        async detachOptionalBinding(profile, key) {
            if (!['preset', 'reasoning-template'].includes(key)) throw new Error('请选择有效的可选绑定。');
            if (typeof profile?.id !== 'string' || !profile.id) throw new Error('请选择有效的已保存连接方案。');
            const current = profiles().find(entry => entry.id === profile?.id);
            if (!current) throw new Error('此连接方案已不存在，请重新打开管理窗口。');
            if (!Object.hasOwn(current, key)) return current;
            if (detachingReasoning) throw new Error('可选绑定正在保存，请稍后再试。');
            detachingReasoning = true;
            const previousBinding = structuredClone(current[key]);
            const hadExclude = Object.hasOwn(current, 'exclude');
            const previousExclude = structuredClone(current.exclude);
            delete current[key];
            current.exclude = [...new Set([...(Array.isArray(current.exclude) ? current.exclude : []), key])];
            try { await verifySavedProfiles([structuredClone(current)]); }
            catch (error) {
                current[key] = previousBinding;
                if (hadExclude) current.exclude = previousExclude; else delete current.exclude;
                saveSettingsDebounced();
                throw error;
            } finally { detachingReasoning = false; }
            syncProfileList();
            return current;
        },
        detachLegacyReasoning(profile) { return runtime.detachOptionalBinding(profile, 'reasoning-template'); },
        async save(profile, updated, { verifyPersistence = false, expectedProxy = null } = {}) {
            const next = normalizeOptionalBindings(updated);
            const owned = new Set(['id', 'name', 'mode', 'api', 'model', 'api-url', 'proxy', 'secret-id', 'custom-connection', 'prompt-post-processing', 'preset', 'reasoning-template', 'exclude', PROFILE_FIELD]);
            for (const [key, value] of Object.entries(profile)) if (!owned.has(key)) next[key] = structuredClone(value);
            const managedCommands = new Set(['api', 'api-url', 'model', 'proxy', 'secret-id', 'custom-connection', 'prompt-post-processing', 'preset', 'reasoning-template']);
            next.exclude = [...new Set([...next.exclude, ...(profile.exclude ?? []).filter(command => !managedCommands.has(command))])];
            if (!next.name?.trim() || profiles().some(entry => entry.id !== profile.id && entry.name === next.name.trim())) throw new Error('请输入未使用的方案名称。');
            next.name = next.name.trim();
            if (next[PROFILE_FIELD]) next[PROFILE_FIELD] = normalizeMetadata(next[PROFILE_FIELD]);
            if (next['custom-connection'] && !next['custom-connection'].excluded) next['custom-connection'] = validateCustomSnapshot(next['custom-connection']);
            if (next[PROFILE_FIELD]?.proxy.mode === 'none') {
                next.proxy = noProxyName();
                next.exclude = next.exclude.filter(field => field !== 'proxy');
            }
            const old = structuredClone(profile);
            if (await saveGroupMembership(profile, old, next, expectedProxy)) return;
            // Edit by ID independently of selection; broken profiles remain editable and deletable.
            for (const field of Object.keys(profile)) if (!Object.hasOwn(next, field)) delete profile[field];
            Object.assign(profile, next);
            if (verifyPersistence) {
                try { await verifySavedProfiles([next], expectedProxy); }
                catch (error) { replaceProfile(profile, old); saveSettingsDebounced(); throw error; }
            }
            authored = true;
            const persistedValue = verifyPersistence ? stableGroupValue(profile) : null;
            try { await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, old, profile); } finally { authored = false; }
            if (!verifyPersistence || stableGroupValue(profile) !== persistedValue) saveSettingsDebounced();
            syncProfileList();
        },
        async remove(profile) {
            const index = profiles().findIndex(entry => entry.id === profile.id);
            if (index < 0) return false;
            profiles().splice(index, 1);
            if (extension_settings.connectionManager.selectedProfile === profile.id) {
                extension_settings.connectionManager.selectedProfile = null;
                await command('profile', '<None>');
            }
            saveSettingsDebounced();
            await eventSource.emit(event_types.CONNECTION_PROFILE_DELETED, profile);
            syncProfileList();
            return true;
        },
        async duplicate(profile) {
            const copy = structuredClone(profile);
            copy.id = uuidv4();
            let name = profile.name + ' 副本';
            for (let n = 2; profiles().some(entry => entry.name === name); n++) name = profile.name + ' 副本 ' + n;
            copy.name = name;
            const snapshot = structuredClone(copy);
            profiles().push(copy);
            authored = true;
            try { await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, copy); } finally { authored = false; }
            // Creation listeners may capture the active connection. A duplicate must keep its own saved tuple.
            for (const key of Object.keys(copy)) if (!Object.hasOwn(snapshot, key)) delete copy[key];
            Object.assign(copy, snapshot);
            saveSettingsDebounced();
            syncProfileList();
            return copy;
        },
        async createModelVariant(profile, { model, name = '', groupId = null } = {}) {
            profile = profiles().find(entry => entry.id === profile?.id);
            if (!profile) throw new Error('原连接方案已不存在。');
            groupRecords([profile.id]);
            const base = structuredClone(profile);
            validate(base);
            let variantName = name.trim() || profile.name + ' · ' + String(model ?? '').trim();
            if (!name.trim()) {
                const baseName = variantName;
                for (let n = 2; profiles().some(entry => entry.name === variantName); n++) variantName = baseName + ' ' + n;
            }
            if (profiles().some(entry => entry.name === variantName)) throw new Error('此方案名称已存在。');
            const copy = modelVariant(base, { model, name: variantName, id: uuidv4() });
            if (copy[PROFILE_FIELD]) copy[PROFILE_FIELD] = normalizeMetadata(copy[PROFILE_FIELD]);
            if (copy['custom-connection'] && !copy['custom-connection'].excluded) copy['custom-connection'] = validateCustomSnapshot(copy['custom-connection']);
            let group = groupId ? groups().find(entry => entry.id === groupId) : groupFor(profile);
            if (groupId && !group) throw new Error('连接组已不存在。');
            const indexed = indexProfiles(profiles());
            if (group && group.profileIds.some(id => !sameProfileAddress(profile, indexed.get(id), proxies))) throw new Error('此方案与连接组的地址不同。');
            if (models && Object.hasOwn(CUSTOM_MODEL_SOURCES, profileSource(copy))) models.ensureOption(profileSource(copy), copy.model);
            const previousGroups = structuredClone(groupSettings().groups ?? []);
            if (!group) {
                let groupName = profile.name;
                for (let n = 2; groups().some(entry => entry.name === groupName); n++) groupName = profile.name + ' ' + n;
                group = createGroup(groupName, [profile.id]);
            }
            const snapshot = structuredClone(copy);
            profiles().push(copy);
            authored = true;
            try { await eventSource.emit(event_types.CONNECTION_PROFILE_CREATED, copy); }
            catch (error) {
                const index = profiles().indexOf(copy);
                if (index >= 0) profiles().splice(index, 1);
                writeGroups(previousGroups);
                throw error;
            }
            finally { authored = false; }
            replaceProfile(copy, snapshot);
            try { assignGroup([copy.id], group.id); }
            catch (error) {
                const index = profiles().indexOf(copy);
                if (index >= 0) profiles().splice(index, 1);
                writeGroups(previousGroups);
                throw error;
            }
            return copy;
        },
        async bindCurrent(key, id) {
            if (!secret_state[key]?.some(entry => entry.id === id)) throw new Error('此密钥已不存在，请刷新列表。');
            if (oai_settings.chat_completion_source === 'custom') {
                const state = oai_settings.custom_provider_state;
                if (state && state.version !== 1) throw new Error('此连接格式暂不支持，请保留原配置。');
                if (!state?.active) {
                    const snapshot = { version: 1, settings: captureCustomFields(oai_settings, true), provider: null, models: { mode: 'discover' }, auth: { mode: 'bearer', required: false }, credential: { mode: 'unbound' } };
                    normalizeCustomEndpoint(oai_settings.custom_url);
                    restoreCustomConnection(snapshot);
                } else {
                    if (state.active.auth.mode === 'none') throw new Error('此服务不使用密钥，请选择“不使用密钥”。');
                    // The user explicitly chose a replacement: release only an invalid old binding before core binding.
                    try { validateCustomSnapshot({ version: 1, settings: captureCustomFields(oai_settings, true), ...state.active }); }
                    catch { state.active.credential = { mode: 'unbound' }; }
                }
                await bindCustomCredential(key, id);
                const binding = oai_settings.custom_provider_state?.active?.credential;
                if (binding?.mode !== 'reference' || binding.key !== key || binding.id !== id || binding.endpoint !== normalizeCustomEndpoint(oai_settings.custom_url)) return false;
            } else {
                if (key !== sourceKey(oai_settings.chat_completion_source, oai_settings)) throw new Error('请选择当前 API 来源对应分类的密钥。');
                await rotateSecret(key, id);
                if (!secret_state[key]?.some(entry => entry.id === id && entry.active)) throw new Error('密钥未能切换，请重试。');
            }
            credentialBeforeNone = null;
            onChange();
            return true;
        },
        async rebindSecret(from, to) {
            if (disposed || !from?.key || from.key !== to?.key || !from.id || !to.id || from.id === to.id) throw new Error('请选择同一服务中有效的重复密钥。');
            if (![from.id, to.id].every(id => secret_state[from.key]?.some(entry => entry.id === id))) throw new Error('重复密钥已变更，请重新识别。');
            const replace = (target, value) => {
                for (const field of Object.keys(target)) if (!Object.hasOwn(value, field)) delete target[field];
                Object.assign(target, value);
            };
            const migrateCredential = value => {
                if (value?.mode === 'reference' && value.key === from.key && value.id === from.id
                    || value?.mode === 'legacy-custom' && from.key === SECRET_KEYS.CUSTOM && value.id === from.id) return { ...value, id: to.id };
                return null;
            };
            const changes = profiles().flatMap(profile => {
                const next = rebindProfileSecret(profile, from, to, sourceKey);
                return next ? [{ profile, previous: structuredClone(profile), next }] : [];
            });
            const previousState = oai_settings.custom_provider_state;
            const nextState = previousState && structuredClone(previousState);
            const stateChanges = [];
            const migrateSlot = (slot, path) => {
                const credential = migrateCredential(slot?.credential);
                if (!credential) return;
                slot.credential = credential;
                stateChanges.push({ path, credential });
            };
            migrateSlot(nextState?.active, ['active']);
            migrateSlot(nextState?.manual, ['manual']);
            for (const [id, slot] of Object.entries(nextState?.drafts ?? {})) migrateSlot(slot, ['drafts', id]);
            const previousPending = credentialBeforeNone;
            const pendingCredential = migrateCredential(previousPending?.credential);
            if (!changes.length && !stateChanges.length && !pendingCredential) {
                usage.mergeSecret(from, to);
                return { profiles: 0, current: false, requiresReverification: false };
            }
            for (const change of changes) replace(change.profile, change.next);
            if (stateChanges.length) oai_settings.custom_provider_state = nextState;
            if (pendingCredential) credentialBeforeNone = { ...previousPending, credential: pendingCredential };
            let persisted = false;
            const confirmed = () => { persisted = true; };
            eventSource.on(event_types.SETTINGS_UPDATED, confirmed);
            try {
                const result = await saveSettings();
                if (result === false || !persisted) throw new Error('方案密钥绑定未能保存，已保留重复密钥，请重试。');
                // Core swallows save errors; also verify the stored bindings to reject an unrelated concurrent save.
                const response = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' });
                if (!response.ok) throw new Error('无法确认方案密钥绑定已保存，已保留重复密钥，请重试。');
                const data = await response.json();
                const saved = typeof data.settings === 'string' ? JSON.parse(data.settings) : data.settings;
                const savedProfiles = saved?.extension_settings?.connectionManager?.profiles ?? [];
                const indexed = indexProfiles(savedProfiles);
                const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
                for (const { previous, next } of changes) {
                    const stored = indexed.get(next.id);
                    if (!stored
                        || previous['secret-id'] !== next['secret-id'] && stored['secret-id'] !== next['secret-id']
                        || !same(previous[PROFILE_FIELD]?.credential, next[PROFILE_FIELD]?.credential) && !same(stored[PROFILE_FIELD]?.credential, next[PROFILE_FIELD]?.credential)
                        || !same(previous['custom-connection']?.credential, next['custom-connection']?.credential) && !same(stored['custom-connection']?.credential, next['custom-connection']?.credential)) {
                        throw new Error('方案密钥绑定未能完整保存，已保留重复密钥，请重试。');
                    }
                }
                for (const { path, credential } of stateChanges) {
                    const slot = path.reduce((value, key) => value?.[key], saved?.oai_settings?.custom_provider_state);
                    if (!same(slot?.credential, credential)) throw new Error('当前连接的密钥绑定未能保存，已保留重复密钥，请重试。');
                }
            } catch (error) {
                for (const change of changes) replace(change.profile, change.previous);
                if (stateChanges.length) oai_settings.custom_provider_state = previousState;
                credentialBeforeNone = previousPending;
                saveSettingsDebounced();
                throw error;
            } finally { eventSource.removeListener(event_types.SETTINGS_UPDATED, confirmed); }
            authored = true;
            try {
                for (const { profile, previous } of changes) await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, previous, profile);
            } finally { authored = false; }
            usage.mergeSecret(from, to);
            refreshCustomConnection();
            syncProfileList();
            return { profiles: changes.length, current: stateChanges.some(change => change.path[0] === 'active') };
        },
        noKey: enableNoKey,
        async refresh() { await readSecretState(); usage.prune(profiles(), secret_state); onChange(); },
        reconnect: connectChatCompletion,
        cleanup() {
            disposed = true; credentialBeforeNone = null; stopRequestObserver(); usage.cleanup();
            for (const timer of mutationTimers) clearTimeout(timer);
            mutationTimers.clear(); mutationLoads.clear();
            for (const remove of listeners) remove();
            if (groups().some(group => group.profileIds.length)) syncProfileList(true);
        },
    };
    const selectConnection = runtime.select.bind(runtime);
    const deselectConnection = runtime.deselect.bind(runtime);
    const startNewConnection = runtime.startNewConnection.bind(runtime);
    runtime.select = (...args) => enqueueSwitch(() => selectConnection(...args));
    runtime.deselect = (...args) => enqueueSwitch(() => deselectConnection(...args));
    runtime.startNewConnection = (...args) => enqueueSwitch(() => startNewConnection(...args));
    return runtime;
}
