import { element, button, dialog, field, showError } from '../ui/common.js';
import { installModelPicker } from '../models/picker.js';
import { CUSTOM_MODEL_SOURCES } from '../models/custom.js';
import { buildProfileGroupRows } from './groups.js';

const sourceOf = profile => profile['connection-workbench']?.source ?? (profile.api === 'google' ? 'makersuite' : profile.api);
const closeEditor = root => root.closest('dialog')?.querySelector('.popup-button-ok')?.click();

function defaultGroupName(profile) {
    if (typeof profile.name === 'string' && profile.name.trim()) return profile.name.trim();
    const address = profile['connection-workbench']?.fields?.custom_url ?? profile['custom-connection']?.settings?.custom_url ?? profile['api-url'];
    if (address) {
        try { return new URL(address).host; } catch { /* Use a readable saved name for older records. */ }
    }
    return CUSTOM_MODEL_SOURCES[sourceOf(profile)]?.label ?? profile.name ?? '我的连接';
}

export function createProfileGroupControls({ runtime, models = null, onChange = () => {}, onEdit = async () => {},
    getSelectedIds = () => [], getMulti = () => false, getSearching = () => false, isBusy = () => false, onError = showError } = {}) {
    const collapsed = new Set();
    const headingControls = new Map();
    let actionBusy = false;
    let filterSignature = '';
    let visibleGroupIds = null;
    const filter = element('select', { class: 'text_pole cw-group-filter', 'aria-label': '筛选连接组',
        onchange: () => onChange(true) });
    const report = error => { try { onError(error); } catch { /* Keep the dialog usable after reporting. */ } };
    async function act(callback) {
        if (actionBusy || isBusy()) return;
        actionBusy = true;
        update();
        try { await callback(); } catch (error) { report(error); }
        finally { actionBusy = false; onChange(); }
    }
    const selectedProfiles = () => {
        const ids = new Set(getSelectedIds());
        return runtime.profiles().filter(profile => ids.has(profile.id));
    };
    const preferredProfile = profiles => profiles.find(profile => profile.id === runtime.selected()?.id) ?? profiles[0];
    const eligible = () => runtime.profiles().filter(profile => profile.mode === 'cc');

    async function createGroup() {
        const profiles = eligible();
        if (!profiles.length) throw new Error('请先保存一个聊天补全连接方案。');
        const chosen = getMulti() ? selectedProfiles() : [];
        const initial = preferredProfile(chosen.length ? chosen : profiles);
        const root = element('div', { class: 'cw-dialog cw-editor cw-group-editor' });
        const base = element('select', { class: 'text_pole', 'aria-label': '使用现有连接', disabled: chosen.length > 1 },
            profiles.map(profile => new Option(profile.name, profile.id)));
        base.value = initial.id;
        const name = element('input', { class: 'text_pole', value: defaultGroupName(initial), autocomplete: 'off', 'aria-label': '连接组名称' });
        const include = element('input', { type: 'checkbox', checked: !chosen.length });
        const candidateNote = element('span');
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        let previousDefault = name.value;
        const idsToGroup = () => {
            const ids = new Set(chosen.length > 1 ? chosen.map(profile => profile.id) : [base.value]);
            if (include.checked) for (const profile of runtime.groupCandidates(profiles.find(entry => entry.id === base.value))) ids.add(profile.id);
            return [...ids];
        };
        const refresh = () => {
            const profile = profiles.find(entry => entry.id === base.value);
            const candidates = runtime.groupCandidates(profile).filter(entry => entry.id !== profile.id);
            candidateNote.textContent = `同时归入地址相同的 ${candidates.length} 个方案`;
            include.disabled = !candidates.length;
            if (name.value === previousDefault) name.value = defaultGroupName(profile);
            previousDefault = defaultGroupName(profile);
        };
        base.addEventListener('change', refresh);
        const save = button('保存', async () => {
            try {
                const group = await runtime.createGroup(name.value.trim(), idsToGroup());
                update();
                filter.value = group.id;
                onChange(true);
                closeEditor(root);
            } catch (error) { status.textContent = error.message; report(error); }
        }, '', { textOnly: true });
        root.append(element('h3', { text: '新建连接组' }), field('连接组名称', name), field('使用现有连接', base,
            chosen.length > 1 ? `归入已选的 ${chosen.length} 个方案；它们须使用相同地址。` : '按此方案的地址归组，每个方案独立保存密钥和其他设置。'),
        element('label', { class: 'cw-group-include' }, [include, candidateNote]), status,
        element('div', { class: 'cw-footer' }, [save]));
        refresh();
        await dialog(root);
    }

    async function assignSelected() {
        const profiles = selectedProfiles();
        if (!profiles.length) throw new Error('请先勾选需要归组的方案。');
        const root = element('div', { class: 'cw-dialog cw-editor cw-group-editor' });
        const target = element('select', { class: 'text_pole', 'aria-label': '归入连接组' }, [
            new Option('新建连接组', 'new'), ...runtime.groups().map(group => new Option(group.name, group.id)), new Option('移出连接组', 'none'),
        ]);
        const name = element('input', { class: 'text_pole', value: defaultGroupName(preferredProfile(profiles)), autocomplete: 'off', 'aria-label': '连接组名称' });
        const nameField = field('连接组名称', name);
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        target.addEventListener('change', () => { nameField.hidden = target.value !== 'new'; status.textContent = ''; });
        const save = button('保存', async () => {
            try {
                const ids = profiles.map(profile => profile.id);
                if (target.value === 'new') await runtime.createGroup(name.value.trim(), ids);
                else await runtime.assignGroup(ids, target.value === 'none' ? null : target.value);
                onChange();
                closeEditor(root);
            } catch (error) { status.textContent = error.message; report(error); }
        }, '', { textOnly: true });
        root.append(element('h3', { text: '归入连接组' }), field(`已选 ${profiles.length} 个方案`, target,
            '同一地址可以归入同一组；密钥、模型、API 来源和其他设置各自保存。'), nameField, status,
        element('div', { class: 'cw-footer' }, [save]));
        await dialog(root);
    }

    async function addModel(group) {
        const memberIds = new Set(group.profileIds);
        const members = runtime.profiles().filter(profile => memberIds.has(profile.id));
        const base = preferredProfile(members);
        if (!base) throw new Error('此连接组已没有可用的方案。');
        const root = element('div', { class: 'cw-dialog cw-editor cw-group-model-editor' });
        const model = element('input', { class: 'text_pole', autocomplete: 'off', placeholder: '搜索或填写模型 ID', 'aria-label': '模型 ID' });
        const name = element('input', { class: 'text_pole', autocomplete: 'off', placeholder: '留空时使用模型 ID', 'aria-label': '模型方案名称' });
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        const source = sourceOf(base);
        const suggestions = new Map();
        for (const profile of members) if (sourceOf(profile) === source && profile.model) suggestions.set(profile.model, { id: profile.model, label: profile.model });
        const selector = CUSTOM_MODEL_SOURCES[source]?.selector
            ?? (source === 'custom' ? '#model_custom_select' : source === 'azure_openai' ? '#azure_openai_model' : null);
        const selected = runtime.selected();
        // A relay's fetched list belongs to its active connection, unlike static provider options.
        const sameConnection = selected?.id === base.id;
        if (selector && (source !== 'custom' || sameConnection)) {
            for (const option of document.querySelector(selector)?.options ?? []) {
                if (option.value && !option.disabled && !option.hidden && !option.parentElement?.disabled && !option.parentElement?.hidden) {
                    suggestions.set(option.value, { id: option.value, label: option.textContent.trim(),
                        custom: option.hasAttribute('data-connection-workbench-models') });
                }
            }
        }
        if (Object.hasOwn(CUSTOM_MODEL_SOURCES, source)) {
            for (const entry of models?.list(source) ?? []) suggestions.set(entry.id, { ...entry, custom: true });
        }
        const modelField = field('模型', model, '新方案初始沿用所选方案的连接和密钥，保存后可独立更换。');
        const picker = installModelPicker(model);
        picker.setItems([...suggestions.values()]);
        const save = button('保存', async () => {
            try {
                await runtime.createModelVariant(base, { model: model.value.trim(), name: name.value.trim(), groupId: group.id });
                collapsed.delete(group.id);
                onChange();
                closeEditor(root);
            } catch (error) { status.textContent = error.message; report(error); }
        }, '', { textOnly: true });
        root.append(element('h3', { text: `添加模型方案 · ${group.name}` }), modelField, field('名称（可选）', name), status,
            element('div', { class: 'cw-footer' }, [save]));
        try { await dialog(root); } finally { picker.cleanup(); }
    }

    async function manageGroup(group) {
        const root = element('div', { class: 'cw-dialog cw-editor cw-group-editor cw-group-manager' });
        const name = element('input', { class: 'text_pole', value: group.name, autocomplete: 'off', 'aria-label': '连接组名称' });
        const status = element('div', { class: 'cw-progress cw-note', role: 'status' });
        const save = button('保存', async () => {
            try { await runtime.renameGroup(group.id, name.value.trim()); onChange(); closeEditor(root); }
            catch (error) { status.textContent = error.message; report(error); }
        }, '', { textOnly: true });
        const edit = button('编辑组内方案', async () => {
            const current = runtime.groups().find(entry => entry.id === group.id);
            const base = preferredProfile(runtime.profiles().filter(profile => current?.profileIds.includes(profile.id)));
            if (!base) { status.textContent = '此连接组已没有可用的方案。'; return; }
            await onEdit(base);
            onChange();
        }, '', { textOnly: true });
        const remove = button('解散连接组', async () => {
            try { await runtime.removeGroup(group.id); onChange(); closeEditor(root); }
            catch (error) { status.textContent = error.message; report(error); }
        }, '', { textOnly: true });
        root.append(element('h3', { text: '管理连接组' }), field('连接组名称', name),
            element('div', { class: 'cw-note', text: `组内 ${group.profileIds.length} 个方案按相同地址归类。每个方案独立保存密钥、模型、API 来源和其他设置；编辑一个方案不影响其他方案，更换到其他地址时会移出原组。` }),
            element('div', { class: 'cw-note', text: '解散只移除分组，保留所有方案和密钥。' }), status,
            element('div', { class: 'cw-footer' }, [edit, remove, save]));
        await dialog(root);
    }

    const createButton = button('新建连接组', () => act(createGroup));
    const assignButton = button('归入连接组', () => act(assignSelected));
    const stateGroups = () => runtime.groups().filter(group => group.profileIds.length
        && (visibleGroupIds ? visibleGroupIds.has(group.id) : filter.value !== 'ungrouped' && (!filter.value || filter.value === group.id)));
    const stateButton = button('全部收起', () => {
        if (actionBusy || isBusy() || getSearching() || getMulti()) return;
        const groups = stateGroups();
        const expand = groups.some(group => collapsed.has(group.id));
        for (const group of groups) { if (expand) collapsed.delete(group.id); else collapsed.add(group.id); }
        onChange();
    }, 'cw-manager-group-state');
    stateButton.setAttribute('aria-controls', 'cw-profile-manager-list');
    function update() {
        const groups = runtime.groups();
        const signature = JSON.stringify(groups.map(group => [group.id, group.name, group.profileIds.length]));
        if (signature !== filterSignature) {
            const value = filter.value;
            filter.replaceChildren(new Option('全部连接组', ''), new Option('未分组', 'ungrouped'),
                ...groups.map(group => new Option(`${group.name} (${group.profileIds.length})`, group.id)));
            filter.value = groups.some(group => group.id === value) || value === 'ungrouped' ? value : '';
            filterSignature = signature;
        }
        const disabled = actionBusy || isBusy();
        filter.disabled = createButton.disabled = disabled;
        assignButton.hidden = !getMulti();
        assignButton.disabled = disabled || !selectedProfiles().length;
        const visibleGroups = stateGroups();
        const forced = getSearching() || getMulti();
        const expand = !forced && visibleGroups.some(group => collapsed.has(group.id));
        const action = expand ? '全部展开' : '全部收起';
        stateButton.hidden = !visibleGroups.length;
        stateButton.disabled = disabled || forced;
        stateButton.title = action;
        stateButton.setAttribute('aria-label', action);
        stateButton.setAttribute('aria-expanded', String(!expand));
        stateButton.querySelector('i').className = `fa-solid ${expand ? 'fa-expand' : 'fa-compress'}`;
        for (const [control, role] of headingControls) {
            if (!control.isConnected) { headingControls.delete(control); continue; }
            control.disabled = disabled || (role === 'disclosure' && getMulti()) || role === 'empty-add';
        }
    }
    function renderHeading(item) {
        const { group, expanded } = item;
        const row = element('div', { class: 'cw-group-heading', 'data-cw-group-id': group?.id ?? '' });
        if (!group) { row.append(element('span', { class: 'cw-group-name', text: '未分组' }), element('small', { class: 'cw-group-count cw-note', text: String(item.count) })); return row; }
        const toggle = element('button', { type: 'button', class: 'cw-group-disclosure no-theme-sync', 'aria-label': `${expanded ? '收起' : '展开'}连接组 ${group.name}`,
            'aria-expanded': String(expanded), disabled: actionBusy || isBusy() || getMulti(), onclick: () => {
                if (actionBusy || isBusy() || getMulti()) return;
                if (collapsed.has(group.id)) collapsed.delete(group.id); else collapsed.add(group.id);
                onChange();
            } }, [element('span', { class: 'cw-group-name', text: group.name }),
                element('small', { class: 'cw-group-count cw-note', text: String(item.count) }),
                element('i', { class: 'fa-solid fa-angle-right cw-group-arrow', 'aria-hidden': 'true' })]);
        const add = button('添加模型方案', () => act(() => addModel(group)));
        const manage = button('管理连接组', () => act(() => manageGroup(group)));
        add.disabled = actionBusy || isBusy() || !group.profileIds.length;
        manage.disabled = actionBusy || isBusy();
        headingControls.set(toggle, 'disclosure');
        headingControls.set(add, group.profileIds.length ? 'add' : 'empty-add');
        headingControls.set(manage, 'manage');
        row.append(toggle, element('div', { class: 'cw-row-actions' }, [add, manage]));
        return row;
    }
    update();
    return { filter, createButton, assignButton, stateButton, update, renderHeading,
        matches(profile) { const group = runtime.groupFor(profile); return !filter.value || (filter.value === 'ungrouped' ? !group : group?.id === filter.value); },
        searchable(profile) { return runtime.groupFor(profile)?.name ?? ''; },
        rows(profiles, options = {}) {
            const groups = runtime.groups();
            const ids = new Set(profiles.map(profile => profile.id));
            visibleGroupIds = new Set(groups.filter(group => group.profileIds.some(id => ids.has(id))).map(group => group.id));
            const emptyGroupIds = filter.value === 'ungrouped' ? [] : groups.filter(group => !filter.value || group.id === filter.value).map(group => group.id);
            return buildProfileGroupRows(profiles, groups, { collapsed, emptyGroupIds, ...options });
        },
    };
}
