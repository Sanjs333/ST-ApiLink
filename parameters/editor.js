import { Popup } from '../../../../popup.js';
import { element, button, dialog, field, showError, themedPopupOptions } from '../ui/common.js';
import { installSearchableSelects } from '../ui/select.js';

const FIELDS = [
    ['custom_include_body', '包含请求体参数', '', '要加入聊天补全请求体的参数（YAML 对象或 JSON）。\n\n示例：\ntop_k: 20\nrepetition_penalty: 1.1'],
    ['custom_exclude_body', '排除请求体参数', '', '要从聊天补全请求体中移除的参数（YAML 列表）。\n\n示例：\n- frequency_penalty\n- presence_penalty'],
    ['custom_include_headers', '附加请求头', '认证信息请通过密钥设置，附加请求头不能覆盖。', '聊天补全请求的附加请求头（YAML 对象或 JSON）。\n\n示例：\nX-Custom-Header: value\nX-Another-Header: value'],
];
const parameterFields = value => Object.fromEntries(FIELDS.map(([key]) => [key, typeof value?.[key] === 'string' ? value[key] : '']));
const sameFields = (left, right) => FIELDS.every(([key]) => (left?.[key] ?? '') === (right?.[key] ?? ''));
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function updatePresetOptions(select, presets, defaults) {
    const options = select.options;
    const unchanged = options.length === defaults.length + presets.length
        && defaults.every(([text, value], index) => options[index].text === text && options[index].value === value)
        && presets.every((preset, index) => options[index + defaults.length].value === 'preset:' + preset.id
            && options[index + defaults.length].text === preset.name);
    if (unchanged) return;
    const fragment = select.ownerDocument.createDocumentFragment();
    for (const [text, value] of defaults) fragment.append(new Option(text, value));
    for (const preset of presets) fragment.append(new Option(preset.name, 'preset:' + preset.id));
    select.replaceChildren(fragment);
}

export function createParameterPresetControls({ store, readFields, writeFields, onError = showError }) {
    const root = element('div', { class: 'cw-field cw-parameter-presets' });
    root.dataset.cwParameterPresets = '';
    const select = element('select', { class: 'text_pole', 'aria-label': '附加参数预设' });
    const status = element('span', { class: 'cw-note cw-parameter-preset-status', role: 'status' });
    let stopped = false, selectedPresetId = null, contextVersion = 0, editorPromise = null;
    const report = error => {
        status.textContent = error?.message || '附加参数操作失败，请重试。';
        status.classList.add('cw-important-note');
        try { onError(error); } catch {}
    };
    function refresh({ resetSelection = false } = {}) {
        if (stopped) return;
        try {
            if (resetSelection) { selectedPresetId = null; contextVersion++; }
            const values = parameterFields(readFields()), presets = store.list();
            const empty = FIELDS.every(([key]) => !values[key].trim());
            const previous = presets.find(preset => preset.id === selectedPresetId);
            const matching = previous && sameFields(previous.fields, values) ? previous
                : !empty && presets.find(preset => sameFields(preset.fields, values));
            if (matching) selectedPresetId = matching.id;
            else if (!previous) selectedPresetId = null;
            updatePresetOptions(select, presets, [['不使用附加参数', 'none'], ['自定义参数', 'custom']]);
            select.value = matching ? 'preset:' + matching.id : empty ? 'none' : 'custom';
        } catch (error) { report(error); }
    }
    async function openEditor() {
        if (stopped) return;
        if (editorPromise) return editorPromise;
        const version = contextVersion;
        editorPromise = editParameters({ store, selectedId: selectedPresetId, initialFields: parameterFields(readFields()),
            canApply: () => !stopped && version === contextVersion, apply: writeFields, onError });
        try {
            const result = await editorPromise;
            if (result && !stopped && version === contextVersion) selectedPresetId = result.presetId;
            refresh();
            return result;
        } finally { editorPromise = null; }
    }
    const edit = button('编辑附加参数', openEditor, 'cw-icon-button');
    edit.replaceChildren(element('i', { class: 'fa-solid fa-pen', 'aria-hidden': 'true' }));
    const onSelect = () => {
        try {
            if (select.value === 'custom') { refresh(); return; }
            const preset = select.value.startsWith('preset:') ? store.get(select.value.slice(7)) : null;
            if (select.value !== 'none' && !preset) throw new Error('此附加参数预设已不存在，请重新选择。');
            writeFields(parameterFields(preset?.fields));
            selectedPresetId = preset?.id ?? null;
            status.textContent = '';
            refresh();
        } catch (error) { refresh(); report(error); }
    };
    select.addEventListener('change', onSelect);
    root.append(element('div', { class: 'cw-field-heading' }, [element('span', { text: '附加参数预设' })]),
        element('div', { class: 'cw-parameter-preset-row' }, [select, edit]), status);
    const unsubscribe = store.subscribe(() => refresh());
    refresh();
    const removePicker = installSearchableSelects({ root, selectors: ['select'], autoGroup: true, replaceExisting: true, onError });
    return { root, refresh, openEditor, cleanup() {
        if (stopped) return;
        stopped = true;
        unsubscribe?.();
        select.removeEventListener('change', onSelect);
        removePicker();
    } };
}

async function editParameters({ store, selectedId, initialFields, canApply, apply, onError }) {
    const root = element('div', { class: 'cw-dialog cw-editor cw-parameter-preset-editor' });
    const controls = element('div', { class: 'cw-fields' });
    const saved = element('select', { class: 'text_pole', 'aria-label': '编辑附加参数预设' });
    const name = element('input', { class: 'text_pole', autocomplete: 'off', 'aria-label': '附加参数预设名称' });
    const status = element('span', { class: 'cw-note cw-parameter-preset-status', role: 'status' });
    const inputs = Object.fromEntries(FIELDS.map(([key, label, note, placeholder]) => {
        const input = element('textarea', { rows: 8, 'aria-label': label, placeholder, value: initialFields[key] });
        const group = field(label, input, note);
        group.classList.add('cw-parameter-field');
        controls.append(group);
        return [key, input];
    }));
    let editingId = store.get(selectedId)?.id ?? null, busy = false, finished = false, result = null;
    name.value = store.get(editingId)?.name ?? '';
    const report = error => {
        status.textContent = error?.message || '附加参数未能保存，请重试。';
        status.classList.add('cw-important-note');
        try { onError(error); } catch {}
    };
    const assertContext = () => {
        if (!canApply()) throw new Error('连接已切换，请关闭后重新打开附加参数编辑。');
    };
    function renderOptions() {
        const presets = store.list();
        if (editingId && !presets.some(preset => preset.id === editingId)) editingId = null;
        updatePresetOptions(saved, presets, [['当前参数（自定义）', 'current']]);
        saved.value = editingId ? 'preset:' + editingId : 'current';
        remove.disabled = busy || !editingId;
    }
    async function act(action) {
        if (busy) return;
        busy = true;
        const states = [...root.querySelectorAll('input, select, textarea'),
            ...(root.closest('dialog')?.querySelectorAll('.popup-controls button') ?? [])].map(control => [control, control.disabled]);
        for (const [control] of states) control.disabled = true;
        try { await action(); }
        catch (error) { report(error); }
        finally {
            busy = false;
            for (const [control, disabled] of states) control.disabled = disabled;
            renderOptions();
        }
    }
    async function save(asNew) {
        await act(async () => {
            assertContext();
            const fields = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
            const values = store.validate ? store.validate(fields) : parameterFields(fields);
            const presetName = name.value.trim();
            if (asNew && !presetName) throw new Error('请输入新的附加参数预设名称。');
            let preset = null;
            if (asNew || presetName) {
                preset = await store.save({ ...(!asNew && editingId ? { id: editingId } : {}), name: presetName, fields: values });
                editingId = preset.id;
            }
            assertContext();
            await apply(values);
            result = { presetId: preset?.id ?? null };
            finished = true;
            const close = root.closest('dialog')?.querySelector('.popup-button-ok');
            if (close) { close.disabled = false; close.click(); }
        });
    }
    const saveAs = button('另存为预设', () => save(true), '', { textOnly: true });
    const saveButton = button('保存', () => save(false), '', { textOnly: true });
    const remove = button('删除预设', () => act(async () => {
        assertContext();
        const preset = store.get(editingId);
        if (!preset) throw new Error('请选择一个已保存的附加参数预设。');
        if (!await Popup.show.confirm('删除附加参数预设', `删除「${escapeHtml(preset.name)}」？已保存连接方案中的参数会保留。`, themedPopupOptions())) return;
        assertContext();
        if (!await store.remove(preset.id)) throw new Error('此附加参数预设已不存在，请重新选择。');
        editingId = null;
        name.value = '';
        status.textContent = '已删除预设，当前参数保留。';
        status.classList.remove('cw-important-note');
    }), '', { textOnly: true });
    saved.addEventListener('change', () => {
        const preset = saved.value.startsWith('preset:') ? store.get(saved.value.slice(7)) : null;
        editingId = preset?.id ?? null;
        name.value = preset?.name ?? '';
        const fields = preset?.fields ?? initialFields;
        for (const [key, input] of Object.entries(inputs)) input.value = fields[key] ?? '';
        status.textContent = '';
        renderOptions();
    });
    controls.prepend(element('div', { class: 'cw-parameter-preset-meta' }, [field('预设', saved), field('预设名称', name)]));
    root.append(element('h3', { text: '编辑附加参数' }),
        element('p', { class: 'cw-note', text: '保存后应用于当前连接；预设修改不会改变其他连接方案已保存的参数。' }),
        controls, status, element('div', { class: 'cw-footer' }, [saveAs, saveButton, remove]));
    const unsubscribe = store.subscribe(renderOptions);
    renderOptions();
    const removePicker = installSearchableSelects({ root, selectors: ['select'], autoGroup: true, replaceExisting: true, onError });
    try { await dialog(root, { onClosing: () => !busy || finished }); }
    finally { unsubscribe?.(); removePicker(); }
    return result;
}
