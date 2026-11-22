import { CUSTOM_MODEL_SOURCES } from './custom.js';
import { groupModelEntries } from './grouping.js';
import { element, button, field, dialog, showError } from '../ui/common.js';
import { installSearchableSelects } from '../ui/select.js';

export async function manageCustomModels({ initialSource, getActiveModel, listModels, addModel, useModel, removeModel, onError = showError }) {
    const root = element('div', { class: 'cw-dialog cw-editor cw-custom-model-editor' });
    const source = element('select', { class: 'text_pole', 'aria-label': '模型所属来源' },
        Object.entries(CUSTOM_MODEL_SOURCES).map(([key, config]) => new Option(config.label, key)));
    source.value = Object.hasOwn(CUSTOM_MODEL_SOURCES, initialSource) ? initialSource : 'openai';
    const selected = element('select', { class: 'text_pole', 'aria-label': '已添加模型' });
    const id = element('input', { class: 'text_pole', placeholder: '模型 ID', autocomplete: 'off', 'aria-label': '模型 ID' });
    const label = element('input', { class: 'text_pole', placeholder: '名称（可选）', autocomplete: 'off', 'aria-label': '模型显示名称' });
    const details = element('small', { class: 'cw-note cw-model-status' });
    const status = element('div', { class: 'cw-note cw-progress', role: 'status' });
    let entries = [], busy = false;
    const act = async callback => {
        if (busy) return;
        busy = true;
        updateControls();
        try { await callback(); status.textContent = ''; }
        catch (error) { status.textContent = error.message; onError(error); }
        finally { busy = false; updateControls(); }
    };
    const use = button('使用', () => act(() => useModel(source.value, selected.value)));
    const remove = button('移除', () => act(async () => { await removeModel(source.value, selected.value); render(); }));
    const add = button('添加模型', () => act(async () => {
        const value = id.value.trim();
        await addModel(source.value, value, label.value || value);
        id.value = ''; label.value = '';
        render(value);
    }));
    function updateControls() {
        source.disabled = selected.disabled = id.disabled = label.disabled = add.disabled = busy;
        use.disabled = remove.disabled = busy || !selected.value;
        details.textContent = selected.value;
    }
    function render(value = selected.value || getActiveModel(source.value)) {
        entries = groupModelEntries(listModels(source.value).map(entry => ({ ...entry, custom: true })));
        const groups = new Map();
        const nodes = [new Option(entries.length ? '选择已添加模型' : '尚未添加模型', '')];
        for (const entry of entries) {
            const option = new Option(entry.label || entry.id, entry.id);
            if (!entry.group) { nodes.push(option); continue; }
            if (!groups.has(entry.groupKey)) {
                const group = element('optgroup', { label: entry.group });
                groups.set(entry.groupKey, group); nodes.push(group);
            }
            groups.get(entry.groupKey).append(option);
        }
        selected.replaceChildren(...nodes);
        selected.value = entries.some(entry => entry.id === value) ? value : '';
        updateControls();
    }
    source.addEventListener('change', () => { status.textContent = ''; render(getActiveModel(source.value)); });
    selected.addEventListener('change', updateControls);
    root.addEventListener('cw-action-settled', updateControls);
    root.append(element('h3', { text: '自定义模型' }), field('模型所属来源', source),
        field('已添加模型', element('div', { class: 'cw-field-inline cw-model-input' }, [selected, use, remove])), details,
        field('添加模型', element('div', { class: 'cw-model-add' }, [id, label, add])),
        element('small', { class: 'cw-note', text: '填写服务实际支持的模型 ID。Custom 和 Azure 可直接使用原生模型输入框。' }), status);
    render();
    const opening = dialog(root);
    const cleanup = installSearchableSelects({ root, selectors: ['select'], autoGroup: false, replaceExisting: true, onError });
    try { await opening; } finally { cleanup(); }
}
