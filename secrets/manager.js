import { getRequestHeaders, eventSource } from '../../../../../script.js';
import { event_types } from '../compat/events.js';
import { SECRET_KEYS, secret_state, readSecretState, writeSecret } from '../compat/secrets.js';
import { customCredentialKeys as CUSTOM_CREDENTIAL_KEYS } from '../compat/host.js';
import { sha256 } from '../compat/libraries.js';
import { Popup, POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../../../popup.js';
import { indexSecretReferences, referencingProfiles } from '../profiles/state.js';
import { sourceKey } from '../profiles/runtime.js';
import { createSecretSelection } from './selection.js';
import { element, button, field, dialog, searchInput, showError, themedPopupOptions } from '../ui/common.js';
import { continuousList, bindListRow, createUsageControls } from '../ui/lists.js';
import { groupDuplicateSecrets, mergeDuplicateSecrets } from './deduplication.js';
import { requestSecretJson, scanSecretFingerprints } from './scanner.js';
import { matchesIdleDays, compareUsageTimes, describeUsage } from '../profiles/usage.js';
import { validateServiceAccountJson } from './service-account.js';

const SPECIAL_NAMES = {
    api_key_custom: 'Custom 兼容接口', api_key_makersuite: 'Google AI Studio',
    api_key_vertexai: 'Vertex AI Express', vertexai_service_account_json: 'Vertex AI 服务账号',
    api_key_claude: 'Claude', api_key_openai: 'OpenAI', api_key_openrouter: 'OpenRouter',
};
export const secretName = key => SPECIAL_NAMES[key] ?? key.replace(/^api_key_/, '');
export const MANAGED_SECRET_KEYS = Object.values(SECRET_KEYS).filter(key => key.startsWith('api_key_') || key === 'vertexai_service_account_json');
const tokenFor = entry => JSON.stringify([entry.key, entry.id]);

export function createSecretManager(runtime, onError = showError) {
    const sessions = new Set();
    let disposed = false;

    async function mutate(action, values) {
        const response = await fetch('/api/secrets/' + action, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(values) });
        if (!response.ok) throw new Error('密钥操作失败，请重试。');
    }

    async function inspectSecret(action, values = {}, signal) {
        return requestSecretJson(action, { values, headers: getRequestHeaders(), signal });
    }

    async function fingerprint(entry, signal) {
        const data = await inspectSecret('find', { key: entry.key, id: entry.id }, signal);
        if (typeof data.value !== 'string' || !data.value) throw new Error('密钥已不存在或无法读取，请重新识别。');
        const digest = await sha256(data.value);
        data.value = '';
        return digest;
    }

    async function add(defaultKey = SECRET_KEYS.CUSTOM, allowedKeys = MANAGED_SECRET_KEYS) {
        const root = element('div', { class: 'cw-dialog cw-editor cw-secret-editor' });
        const category = element('select', { class: 'text_pole' }, allowedKeys.map(key => new Option(secretName(key), key)));
        category.value = defaultKey;
        const label = element('input', { class: 'text_pole', placeholder: '例如：工作中转 / 本地服务', autocomplete: 'off' });
        const value = element('textarea', { class: 'text_pole', rows: 3, autocomplete: 'off', 'aria-label': '新密钥或服务账号 JSON' });
        const valueField = field('密钥', value);
        const note = element('div', { class: 'cw-note' });
        const status = element('div', { class: 'cw-progress cw-note', role: 'status', 'aria-live': 'polite' });
        let saving = false, created = null;
        const save = button('保存', async () => {
            if (saving || disposed) return;
            try {
                if (!label.value.trim() || !value.value.trim()) throw new Error('请输入密钥名称和内容。');
                const key = category.value;
                if (!allowedKeys.includes(key)) throw new Error('请选择有效的密钥服务。');
                const account = key === SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT;
                if (account) validateServiceAccountJson(value.value);
                saving = true;
                category.disabled = label.disabled = value.disabled = save.disabled = true;
                status.classList.remove('cw-important-note');
                status.textContent = account ? '格式校验通过，正在保存 JSON…' : '正在保存密钥…';
                updateFields();
                const id = await writeSecret(key, value.value.trim(), label.value.trim(), { activate: false });
                if (!id) throw new Error(account ? 'JSON 未能保存，请重试。' : '密钥未能保存，请重试。');
                created = { key, id };
                value.value = '';
                root.closest('dialog')?.querySelector('.popup-button-ok')?.click();
            } catch (error) {
                status.textContent = error?.message || '密钥未能保存，请重试。';
                status.classList.add('cw-important-note');
                onError(error);
            } finally {
                saving = false;
                category.disabled = label.disabled = value.disabled = save.disabled = false;
                updateFields();
            }
        }, '', { textOnly: true });
        function updateFields() {
            const account = category.value === SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT;
            valueField.querySelector('span').textContent = account ? 'Service Account JSON' : '密钥';
            const action = saving ? '正在保存…' : account ? '验证并保存 JSON' : '保存';
            save.textContent = save.title = action;
            save.setAttribute('aria-label', action);
            save.setAttribute('aria-busy', String(saving));
            value.rows = account ? 8 : 3;
            value.placeholder = account ? '粘贴完整的服务账号 JSON' : '输入 API 密钥';
            note.textContent = account ? '保存前检查 JSON 格式、账号类型、必填字段和私钥格式。账号是否可用，请选择后检查连接。' : '';
            note.hidden = !account;
        }
        category.addEventListener('change', () => { status.textContent = ''; updateFields(); });
        value.addEventListener('input', () => { status.textContent = ''; });
        label.addEventListener('input', () => { status.textContent = ''; });
        root.append(element('h3', { text: '新增密钥' }), element('div', { class: 'cw-fields' }, [field('所属服务', category), field('名称', label), valueField]), note, status,
            element('div', { class: 'cw-footer' }, [save]));
        updateFields();
        await dialog(root, { okButton: '取消', onClosing: () => !saving || Boolean(created) });
        return created;
    }

    async function open({ onChoose = null, canChoose = () => true, isChosen = null, getChosen = () => runtime.currentCredential?.(), onNone = null, isNone = () => false, onRebind = null, allowedKeys = MANAGED_SECRET_KEYS, defaultKey = '', title = '管理 API 密钥' } = {}) {
        if (disposed) return;
        await readSecretState();
        const root = element('div', { class: 'cw-dialog cw-manager' });
        const list = element('div', { class: 'cw-list' });
        const progress = element('div', { class: 'cw-progress cw-note', role: 'status' });
        const count = element('span', { class: 'cw-note cw-bulk-count' });
        const hiddenSelectionNote = element('div', { class: 'cw-note cw-hidden-selection-note', hidden: true });
        const browseCount = element('span', { class: 'cw-note' });
        const selection = createSecretSelection();
        const state = { stop: false, busy: false, scanning: false, closed: false, multi: false, controller: null };
        sessions.add(state);
        let query = '';
        let duplicateGroups = [];
        let referenceIndex = new Map();
        let connectingToken = null;
        const duplicateNotes = new Map();
        const duplicateText = element('span', { class: 'cw-note cw-dedup-count' });
        const cancelled = () => state.stop || state.closed || disposed;
        function discardDuplicates() { duplicateGroups = []; duplicateNotes.clear(); duplicateSummary.hidden = true; }
        const category = element('select', { class: 'text_pole', 'aria-label': '筛选密钥服务' }, [new Option('所有服务', ''), ...allowedKeys.map(key => new Option(secretName(key), key))]);
        category.value = allowedKeys.includes(defaultKey) ? defaultKey : '';
        const referencesFilter = element('select', { class: 'text_pole cw-reference-filter', 'aria-label': '筛选方案引用' }, [new Option('全部引用', ''), new Option('已被方案引用', 'referenced'), new Option('未被方案引用', 'unreferenced')]);
        const usageControls = createUsageControls({ kind: 'secret', onChange: () => render(true) });
        const search = searchInput('搜索密钥名称、服务或 ID', () => { query = search.value.trim().toLocaleLowerCase(); render(true); });
        category.addEventListener('change', () => render(true));
        referencesFilter.addEventListener('change', () => render(true));
        const rows = () => allowedKeys.flatMap(key => (secret_state[key] ?? []).map(entry => ({ key, id: entry.id, label: entry.label, active: entry.active })));
        const lastUsed = entry => runtime.usage?.secretTime(entry.key, entry.id) ?? null;
        const matchesBinding = (entry, current) => current?.key === entry.key && current.id === entry.id;
        const isCurrent = entry => isChosen ? Boolean(isChosen(entry)) : matchesBinding(entry, getChosen());
        const filtered = (entries = rows()) => {
            referenceIndex = indexSecretReferences(runtime.profiles(), sourceKey);
            const now = Date.now();
            const times = new Map(entries.map(entry => [entry, lastUsed(entry)]));
            const binding = isChosen ? null : getChosen();
            const current = new Set(entries.filter(isChosen ?? (entry => matchesBinding(entry, binding))));
            return entries.filter(entry => {
                const hasReferences = Boolean(referenceIndex.get(tokenFor(entry))?.length);
                return (!category.value || entry.key === category.value)
                    && (!query || [entry.label, secretName(entry.key), entry.id, ...(referenceIndex.get(tokenFor(entry)) ?? []).map(profile => profile.name)].join(' ').toLocaleLowerCase().includes(query))
                    && (!referencesFilter.value || (referencesFilter.value === 'referenced' ? hasReferences : !hasReferences))
                    && matchesIdleDays(times.get(entry), usageControls.days, now);
            }).sort((a, b) => Number(current.has(b)) - Number(current.has(a))
                || compareUsageTimes(times.get(a), times.get(b), usageControls.oldestFirst));
        };
        let visibleSecrets = [];
        const guarded = action => async () => { try { await action(); } catch (error) { onError(error); } };
        const selectAll = element('input', { type: 'checkbox', title: '全选搜索结果', 'aria-label': '全选搜索结果', onchange: () => {
            if (!state.multi || state.busy) return;
            scroller.preservePosition(() => {
                for (const entry of visibleSecrets) if (selectAll.checked) selection.add(tokenFor(entry)); else selection.delete(tokenFor(entry));
                updateControls();
            });
        } });
        const clear = button('清空选择', () => scroller.preservePosition(() => { selection.clear(); updateControls(); }));
        const multiToggle = button('多选', () => {
            if (state.busy) return;
            scroller.preservePosition(() => {
                state.multi = !state.multi;
                if (!state.multi) selection.clear();
                usageControls.setMulti(state.multi);
                render();
            });
        }, 'cw-multi-toggle');
        const addKey = button('新增密钥', guarded(async () => { await add(category.value || allowedKeys[0], allowedKeys); discardDuplicates(); render(); }));
        async function renameByProfile(entries) {
            if (state.busy) return;
            state.busy = true; state.stop = false; updateControls();
            let completed = 0, failed = 0, retained = 0, confirmed = false;
            const renamed = [];
            try {
                await readSecretState();
                if (cancelled()) return;
                const index = indexSecretReferences(runtime.profiles(), sourceKey);
                const tokens = new Set(entries.map(tokenFor));
                const plan = rows().filter(entry => tokens.has(tokenFor(entry))).flatMap(entry => {
                    const suggestion = secretPresentation(entry, index.get(tokenFor(entry)) ?? []);
                    return suggestion.canRename ? [{ ...entry, name: suggestion.targetName, profileId: suggestion.targetProfileId }] : [];
                });
                if (!plan.length) { progress.textContent = '没有需要重命名的独占密钥；共用密钥可通过“改名”自行命名。'; return; }
                const preview = element('div', { class: 'cw-dedup-confirm' }, [
                    element('h3', { text: '按方案名重命名' }),
                    element('p', { text: `将${state.multi ? '所选密钥' : '当前筛选结果'}中的 ${plan.length} 把仅被一个方案引用的密钥改为对应方案名称。` }),
                    element('ul', {}, plan.map(entry => element('li', { text: `${secretName(entry.key)}：${entry.label || '未命名密钥'} → ${entry.name}` }))),
                    element('p', { text: '共用密钥、未被引用及名称已一致的密钥会保留。' }),
                ]);
                if (await callGenericPopup(preview, POPUP_TYPE.CONFIRM, '', themedPopupOptions({ wide: true, okButton: '重命名', cancelButton: '取消' })) !== POPUP_RESULT.AFFIRMATIVE || cancelled()) return;
                confirmed = true;
                await readSecretState();
                const liveEntries = new Map(rows().map(entry => [tokenFor(entry), entry]));
                for (const item of plan) {
                    if (cancelled()) break;
                    const current = liveEntries.get(tokenFor(item));
                    const suggestion = current && secretPresentation(current, referencingProfiles(runtime.profiles(), item.key, item.id, sourceKey));
                    if (!current || current.label !== item.label || suggestion.targetProfileId !== item.profileId || suggestion.targetName !== item.name) { retained++; continue; }
                    progress.textContent = `正在重命名 ${completed + failed + retained + 1} / ${plan.length}…`;
                    try { await mutate('rename', { key: item.key, id: item.id, label: item.name }); renamed.push(item); completed++; }
                    catch { failed++; }
                }
                discardDuplicates();
                await readSecretState();
                const savedNames = new Map(rows().map(entry => [tokenFor(entry), entry.label]));
                for (const item of renamed) if (savedNames.get(tokenFor(item)) !== item.name) { completed--; failed++; }
                for (const key of new Set(plan.map(item => item.key))) await eventSource.emit(event_types.SECRET_EDITED, key);
            } finally {
                state.busy = false;
                if (confirmed) progress.textContent = `已重命名 ${completed} 把` + (failed ? `，${failed} 把失败，可重试` : '') + (retained ? `，${retained} 把因名称或引用变化保留` : '');
                render();
            }
        }
        const bulkRename = button('按方案名批量重命名', guarded(() => renameByProfile(state.multi
            ? rows().filter(entry => selection.has(tokenFor(entry))) : filtered())), 'cw-bulk-rename');
        const stopScan = button('停止识别', () => { state.stop = true; state.controller?.abort(); });
        stopScan.hidden = true;
        const scanDuplicates = button('识别重复密钥', guarded(async () => {
            state.busy = true; state.scanning = true; state.stop = false;
            state.controller = new AbortController();
            const controller = state.controller;
            discardDuplicates(); updateControls();
            try {
                progress.textContent = '正在核对密钥读取权限…';
                // Search and category filters only affect browsing; compare the entire managed scope.
                const fingerprints = await scanSecretFingerprints(rows(), {
                    requestSecrets: inspectSecret, hash: sha256, signal: controller.signal,
                    onProgress: ({ completed, total }) => { progress.textContent = completed ? `正在识别 ${completed} / ${total}…` : total ? `正在批量读取 ${total} 把密钥…` : '没有需要比较的密钥。'; },
                });
                if (cancelled()) return;
                duplicateGroups = groupDuplicateSecrets(fingerprints);
                for (const group of duplicateGroups) {
                    duplicateNotes.set(tokenFor(group.keep), '重复密钥 · 保留此项');
                    for (const entry of group.duplicates) duplicateNotes.set(tokenFor(entry), '重复密钥 · 合并到「' + (group.keep.label || '未命名密钥') + '」');
                }
                const duplicates = duplicateGroups.flatMap(group => group.duplicates);
                referenceIndex = indexSecretReferences(runtime.profiles(), sourceKey);
                const references = new Set(duplicates.flatMap(entry => (referenceIndex.get(tokenFor(entry)) ?? []).map(profile => profile.id)));
                duplicateText.textContent = `${duplicateGroups.length} 组重复 · 可合并 ${duplicates.length} 把 · ${references.size} 个方案自动改绑`;
                duplicateSummary.hidden = !duplicates.length;
                progress.textContent = duplicates.length ? '已核对全部服务；仅合并同一服务下完整值相同的密钥，优先保留当前启用项。' : '未发现同一服务下完整值相同的重复密钥。';
            } catch (error) {
                discardDuplicates();
                if (!cancelled()) {
                    progress.textContent = error.message; throw error;
                }
            } finally {
                if (state.stop && !state.closed && !disposed) progress.textContent = '已停止识别，可重新识别。';
                state.controller = null; state.busy = false; state.scanning = false; render();
            }
        }));
        const mergeDuplicates = button('合并重复密钥', guarded(async () => {
            if (state.busy && duplicateGroups.length) { state.stop = true; state.controller?.abort(); updateControls(); return; }
            if (!duplicateGroups.length || state.busy) return;
            const groups = structuredClone(duplicateGroups);
            state.busy = true; state.stop = false; updateControls();
            const affected = new Set();
            try {
                await readSecretState();
                if (cancelled()) return;
                const previewReferences = indexSecretReferences(runtime.profiles(), sourceKey);
                const confirmation = element('div', { class: 'cw-dedup-confirm' }, [
                    element('h3', { text: '合并重复密钥' }),
                    element('p', { text: '保留以下密钥，把重复项引用的方案自动改绑，再删除重复项。搜索和分类筛选不限制此次合并。' }),
                    element('ul', {}, groups.map(group => {
                        const references = new Set(group.duplicates.flatMap(entry => (previewReferences.get(tokenFor(entry)) ?? []).map(profile => profile.id)));
                        return element('li', { text: `${secretName(group.keep.key)}：保留「${group.keep.label || '未命名密钥'}」（${group.keep.id.slice(0, 8)}），合并 ${group.duplicates.length} 把重复项，${references.size} 个方案改绑` });
                    })),
                    element('p', { text: '方案的 API 地址授权会保留。密钥删除后无法撤销；核对或保存失败的项会保留。' }),
                ]);
                if (await callGenericPopup(confirmation, POPUP_TYPE.CONFIRM, '', themedPopupOptions({ wide: true, okButton: '合并', cancelButton: '取消' })) !== POPUP_RESULT.AFFIRMATIVE || cancelled()) return;
                updateControls();
                const result = await mergeDuplicateSecrets({
                    groups, getProfiles: runtime.profiles, getVault: () => secret_state, resolveSourceKey: sourceKey,
                    shouldStop: cancelled,
                    verifyDuplicate: async (from, to) => {
                        const controller = new AbortController(); state.controller = controller;
                        try {
                            const [left, right] = await Promise.all([fingerprint(from, controller.signal), fingerprint(to, controller.signal)]);
                            return left === right;
                        } finally { controller.abort(); if (state.controller === controller) state.controller = null; }
                    },
                    rebindReferences: async (from, to) => {
                        const migration = await runtime.rebindSecret(from, to);
                        await onRebind?.(from, to);
                        return migration;
                    },
                    removeKey: async (key, id) => {
                        if (secret_state[key]?.some(entry => entry.id === id && entry.active)) {
                            const keep = groups.find(group => group.duplicates.some(entry => entry.key === key && entry.id === id))?.keep;
                            if (!keep || !secret_state[key]?.some(entry => entry.id === keep.id)) throw new Error('保留的密钥已不存在，请重新识别。');
                            await mutate('rotate', { key, id: keep.id });
                            await readSecretState();
                            if (!secret_state[key]?.some(entry => entry.id === keep.id && entry.active)) throw new Error('未能保留当前启用的密钥，请重试。');
                            await eventSource.emit(event_types.SECRET_ROTATED, key);
                            if (!secret_state[key]?.some(entry => entry.id === keep.id) || referencingProfiles(runtime.profiles(), key, id, sourceKey).length) throw new Error('密钥引用已变更，请重新识别。');
                        }
                        await mutate('delete', { key, id });
                        await readSecretState();
                        if (secret_state[key]?.some(entry => entry.id === id)) throw new Error('密钥未能删除，请重新识别后重试。');
                        selection.delete(tokenFor({ key, id })); affected.add(key);
                    },
                    onProgress: ({ index, total }) => { progress.textContent = `正在合并 ${index} / ${total}…`; },
                });
                discardDuplicates();
                progress.textContent = `已合并删除 ${result.deleted} 把重复密钥，${result.migrated} 个方案改绑` + (result.failed ? `，${result.failed} 把失败，已保留` : '')
                    + (result.retained ? `，${result.retained} 把因状态变化保留` : '') + (result.stopped ? '，已停止' : '');
                if (result.errors.some(error => error.phase === 'references')) progress.textContent += '。方案或连接改绑未确认保存，请检查连接后重试。';
            } finally {
                state.busy = false; state.controller = null;
                for (const key of affected) await eventSource.emit(event_types.SECRET_DELETED, key);
                render();
            }
        }));
        const duplicateSummary = element('div', { class: 'cw-dedup-summary', hidden: true }, [duplicateText, mergeDuplicates]);
        let nonePending = false;
        const noKey = onNone ? button('不使用密钥', guarded(async () => {
            nonePending = true;
            updateControls();
            try {
                const result = await onNone();
                progress.textContent = result?.message ?? (isNone() ? '当前连接不发送密钥' : '已取消不使用密钥，请选择密钥');
            } finally { nonePending = false; updateControls(); }
        })) : null;
        const stop = button('停止删除', () => { state.stop = true; });
        stop.hidden = true;
        const bulkDelete = button('删除所选', guarded(async () => {
            if (!state.multi || state.busy) return;
            state.busy = true; state.stop = false;
            updateControls();
            const affected = new Set();
            const pendingDeletes = [];
            let completed = 0, failed = 0, retained = 0, confirmed = false;
            try {
                await readSecretState();
                if (cancelled()) return;
                const selected = rows().filter(entry => selection.has(tokenFor(entry)));
                if (!selected.length) throw new Error('请先勾选要删除的密钥。');
                const previewReferences = indexSecretReferences(runtime.profiles(), sourceKey);
                const snapshots = new Map(selected.map(entry => [tokenFor(entry), {
                    profiles: new Set((previewReferences.get(tokenFor(entry)) ?? []).map(profile => profile.id)),
                    active: Boolean(entry.active), current: isCurrent(entry), lastUsed: lastUsed(entry),
                }]));
                const references = new Set([...snapshots.values()].flatMap(snapshot => [...snapshot.profiles]));
                const currentCount = selected.filter(isCurrent).length;
                const defaultCount = selected.filter(entry => entry.active).length;
                const visible = new Set(filtered().map(tokenFor));
                const hidden = selected.filter(entry => !visible.has(tokenFor(entry))).length;
                const message = `删除 ${selected.length} 把密钥？`
                    + (references.size ? ` 有 ${references.size} 个方案引用它们，之后需要重新选择密钥。` : '')
                    + (currentCount ? ` 包含 ${currentCount} 把当前连接使用的密钥。` : '')
                    + (defaultCount ? ` 包含 ${defaultCount} 把服务默认密钥，删除后该服务可能改用其他密钥。` : '')
                    + (hidden ? ` 其中 ${hidden} 把不在当前筛选结果中。` : '');
                if (!await Popup.show.confirm('删除密钥', message, themedPopupOptions()) || cancelled()) return;
                confirmed = true; discardDuplicates(); stop.hidden = false; updateControls();
                await readSecretState();
                for (const entry of selected) {
                    if (cancelled()) break;
                    progress.textContent = `正在删除 ${completed + failed + retained + 1} / ${selected.length}…`;
                    try {
                        if (cancelled()) break;
                        const latest = rows().find(candidate => tokenFor(candidate) === tokenFor(entry));
                        if (!latest) { selection.delete(tokenFor(entry)); continue; }
                        const snapshot = snapshots.get(tokenFor(entry));
                        const newReference = referencingProfiles(runtime.profiles(), entry.key, entry.id, sourceKey).some(profile => !snapshot.profiles.has(profile.id));
                        // Confirmed deletions remain valid only while no new dependency or use appears.
                        if (newReference || (!snapshot.active && latest.active) || (!snapshot.current && isCurrent(latest))
                            || (lastUsed(latest) ?? 0) > (snapshot.lastUsed ?? 0)) { retained++; continue; }
                        await mutate('delete', { key: entry.key, id: entry.id });
                        pendingDeletes.push(entry); affected.add(entry.key); completed++;
                    }
                    catch { failed++; }
                }
            } finally {
                try {
                    await readSecretState();
                    const remaining = new Set(rows().map(tokenFor));
                    for (const entry of pendingDeletes) {
                        if (remaining.has(tokenFor(entry))) { completed--; failed++; }
                        else selection.delete(tokenFor(entry));
                    }
                    for (const key of affected) await eventSource.emit(event_types.SECRET_DELETED, key);
                } finally {
                    state.busy = false; stop.hidden = true;
                    if (confirmed) progress.textContent = `已删除 ${completed} 把` + (failed ? `，${failed} 把失败，可重试` : '')
                        + (retained ? `，${retained} 把因引用或使用状态变化保留，请重新核对` : '') + (state.stop ? '，已停止' : '');
                    render();
                }
            }
        }));
        const scroller = continuousList(list, entry => {
                const token = tokenFor(entry);
                const checkbox = element('input', { type: 'checkbox', value: token, hidden: !state.multi, checked: selection.has(token), disabled: state.busy, 'aria-label': '选择 ' + (entry.label || '未命名密钥'), onchange: () => {
                    if (!state.multi || state.busy) return;
                    if (checkbox.checked) selection.add(token); else selection.delete(token);
                    updateControls(checkbox.closest('.cw-secret-row'));
                } });
                const refs = referenceIndex.get(token) ?? [];
                const presentation = secretPresentation(entry, refs);
                const statuses = [refs.length ? `${refs.length} 个方案引用` : '未被方案引用', ...(isCurrent(entry) ? ['当前连接使用'] : []), ...(entry.active ? ['该服务默认密钥'] : [])];
                const usage = describeUsage(lastUsed(entry));
                const info = element('div', { class: 'cw-row-info' }, [element('span', { class: 'cw-row-title', text: presentation.title, title: presentation.referenceNames || presentation.originalName })]);
                if (refs.length && presentation.originalName !== presentation.title) info.append(element('small', { class: 'cw-note', text: '密钥名：' + presentation.originalName }));
                info.append(element('small', { class: 'cw-note', text: [secretName(entry.key), entry.id.slice(0, 8), ...statuses].join(' · '), title: presentation.referenceNames }),
                    element('small', { class: 'cw-note cw-usage-note', text: '最近使用：' + usage.text, title: usage.title }));
                if (duplicateNotes.has(token)) info.append(element('small', { class: 'cw-warning', text: duplicateNotes.get(token) }));
                const actions = element('div', { class: 'cw-row-actions' });
                actions.append(button('改名', guarded(async () => {
                    const label = await Popup.show.input('密钥改名', presentation.targetName ? '已预填关联方案名，也可输入自定义名称。' : '请输入便于辨认的名称', (presentation.targetName ?? entry.label) || '', themedPopupOptions());
                    if (!label || !String(label).trim()) return;
                    await mutate('rename', { key: entry.key, id: entry.id, label: String(label).trim() });
                    await readSecretState();
                    await eventSource.emit(event_types.SECRET_EDITED, entry.key);
                    render();
                })));
                for (const child of actions.children) child.disabled = state.busy;
                return bindListRow(element('div', { class: 'cw-list-row cw-secret-row' }, [checkbox, info, actions]), {
                    label: presentation.title, isMulti: () => state.multi, isSelected: () => selection.has(token),
                    isDisabled: () => state.busy, canActivate: () => Boolean(onChoose && canChoose(entry)),
                    isCurrent: () => isCurrent(entry), isConnecting: () => connectingToken === token, onError,
                    toggleSelected: () => { if (selection.has(token)) selection.delete(token); else selection.add(token); updateControls(checkbox.closest('.cw-secret-row')); },
                    activate: async ({ keyboard }) => {
                        state.busy = true; connectingToken = token; updateControls();
                        let success = false;
                        try {
                            const result = await onChoose(entry);
                            if (result === false) { progress.textContent = '尚未选择密钥'; return; }
                            success = true;
                            progress.textContent = '已选择：' + presentation.title;
                        } finally {
                            state.busy = false; connectingToken = null; render(success);
                            if (success && keyboard) list.querySelector('[aria-current="true"][tabindex="0"]')?.focus({ preventScroll: true });
                        }
                    },
                });
        }, { emptyText: '没有匹配的密钥', keyOf: tokenFor });
        function updateControls(changedRow) {
            const matches = visibleSecrets;
            const inView = selection.visibleCount;
            const selected = selection.size;
            selectAll.checked = matches.length > 0 && inView === matches.length;
            selectAll.indeterminate = inView > 0 && inView < matches.length;
            selectAll.disabled = state.busy || !matches.length;
            const hidden = selected - inView;
            count.textContent = `共 ${matches.length} 把 · 已选 ${selected} 把`;
            hiddenSelectionNote.textContent = hidden ? `其中 ${hidden} 把不在当前筛选结果中；删除所选仍包含这些密钥。` : '';
            hiddenSelectionNote.hidden = !state.multi || !hidden;
            count.title = [count.textContent, hiddenSelectionNote.textContent].filter(Boolean).join(' · ');
            browseCount.textContent = `符合当前范围 ${matches.length} 把`;
            browseCount.hidden = state.multi;
            bulkControls.hidden = !state.multi;
            multiToggle.title = state.multi ? '退出多选' : '多选';
            multiToggle.setAttribute('aria-label', multiToggle.title);
            multiToggle.setAttribute('aria-pressed', String(state.multi));
            multiToggle.classList.toggle('active', state.multi);
            multiToggle.disabled = state.busy;
            bulkDelete.disabled = state.busy || !selected;
            bulkRename.disabled = state.busy || !selection.canRename(state.multi);
            bulkRename.title = state.multi ? '按方案名批量重命名所选密钥（包含筛选隐藏的已选项）' : '按方案名批量重命名当前筛选结果';
            clear.disabled = state.busy || !selection.size;
            addKey.disabled = scanDuplicates.disabled = search.disabled = category.disabled = referencesFilter.disabled = state.busy;
            usageControls.setDisabled(state.busy);
            stopScan.hidden = !state.scanning;
            mergeDuplicates.disabled = !duplicateGroups.length;
            const stoppingMerge = state.busy && duplicateGroups.length;
            mergeDuplicates.title = stoppingMerge ? '停止合并' : '合并重复密钥';
            mergeDuplicates.setAttribute('aria-label', mergeDuplicates.title);
            mergeDuplicates.querySelector('i').className = 'fa-solid ' + (stoppingMerge ? 'fa-stop' : 'fa-object-group');
            if (noKey) {
                const enabled = Boolean(isNone());
                noKey.disabled = state.busy || nonePending;
                noKey.classList.toggle('active', enabled);
                noKey.setAttribute('aria-pressed', String(enabled));
                noKey.title = enabled ? '取消不使用密钥' : '不使用密钥';
                noKey.setAttribute('aria-label', noKey.title);
            }
            if (changedRow?.cwRefreshState) {
                const checkbox = changedRow.querySelector('input[type="checkbox"]');
                checkbox.checked = selection.has(checkbox.value);
                changedRow.cwRefreshState();
                return;
            }
            for (const control of list.querySelectorAll('button, input[type="checkbox"]')) if (control.disabled !== state.busy) control.disabled = state.busy;
            for (const checkbox of list.querySelectorAll('input[type="checkbox"]')) {
                checkbox.hidden = !state.multi;
                checkbox.checked = selection.has(checkbox.value);
            }
            for (const row of scroller.loadedRows()) row.cwRefreshState?.();
        }
        function render(reset = false) {
            if (state.closed || disposed) return;
            const entries = rows();
            visibleSecrets = filtered(entries);
            const all = new Set(), eligible = new Set();
            for (const entry of entries) {
                const key = tokenFor(entry), refs = referenceIndex.get(key);
                all.add(key);
                if (refs?.length === 1 && secretPresentation(entry, refs).canRename) eligible.add(key);
            }
            selection.refresh(all, new Set(visibleSecrets.map(tokenFor)), eligible);
            if (!state.busy) {
                scroller.setItems(visibleSecrets, { reset });
            }
            updateControls();
        }

        root.addEventListener('cw-action-settled', updateControls);
        const bulkControls = element('div', { class: 'cw-bulk', hidden: true }, [selectAll, count, clear, bulkDelete, stop]);
        root.append(element('div', { class: 'cw-header' }, [element('h3', { text: title }), browseCount, element('div', { class: 'cw-row-actions' }, [...(noKey ? [noKey] : []), scanDuplicates, stopScan, bulkRename, multiToggle, addKey])]),
            element('div', { class: 'cw-search-row' }, [search, category]),
            element('div', { class: 'cw-search-row cw-management-filters' }, [referencesFilter, usageControls.sortButton]),
            usageControls.filterRow, bulkControls, hiddenSelectionNote, duplicateSummary, list, progress);
        render();
        const updateNoneState = () => { if (!state.closed && !disposed) render(); };
        const stateEvents = [event_types.CUSTOM_CONNECTION_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CONNECTION_PROFILE_LOADED, event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED, event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_EDITED, event_types.SECRET_ROTATED].filter(Boolean);
        for (const type of stateEvents) eventSource.on(type, updateNoneState);
        const unsubscribeUsage = runtime.usage?.subscribe(updateNoneState);
        try { await dialog(root); } finally {
            state.closed = true; state.stop = true; state.controller?.abort(); discardDuplicates(); sessions.delete(state); scroller.cleanup();
            for (const type of stateEvents) eventSource.removeListener(type, updateNoneState);
            unsubscribeUsage?.();
        }
    }
    return { open, add,
        async remove(key, id) {
            if (disposed || !MANAGED_SECRET_KEYS.includes(key) || typeof id !== 'string' || !id) throw new Error('请选择有效的已保存密钥。');
            await mutate('delete', { key, id });
            await readSecretState();
            if (secret_state[key]?.some(entry => entry.id === id)) throw new Error('密钥未能删除，请重试。');
        },
        customKeys: CUSTOM_CREDENTIAL_KEYS, cleanup() { disposed = true; for (const state of sessions) { state.closed = true; state.stop = true; state.controller?.abort(); } },
    };
}

/** Derive display names without changing the native secret label or its identity. */
export function secretPresentation(entry, references = []) {
    const originalName = entry.label || '未命名密钥';
    const names = references.map(profile => profile.name?.trim() || '未命名方案');
    const targetName = references.length === 1 ? references[0].name?.trim() || null : null;
    const title = !names.length ? originalName : names.length === 1 ? names[0]
        : names.slice(0, 2).join('、') + (names.length > 2 ? ` 等 ${names.length} 个方案` : '') + ' · 共用密钥';
    return { title, originalName, referenceNames: names.join('、'),
        targetName, targetProfileId: targetName ? references[0].id : null,
        canRename: Boolean(targetName && targetName !== entry.label) };
}
