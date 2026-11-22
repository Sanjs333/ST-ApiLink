import { CUSTOM_MODEL_SOURCES } from '../models/custom.js';
import { button } from '../ui/common.js';
import { projectVertexModelCatalog, clearVertexModelCatalog } from '../models/catalog.js';

export function installNativeModelControls({ onOpen, onRefresh = null, onSelectCatalog = null, getSource = () => null, getModelContext = getSource,
    onError = console.error, documentRef = globalThis.document,
    Observer = globalThis.MutationObserver } = {}) {
    const controls = new Map();
    const observationRoot = documentRef.querySelector('#rm_api_block') ?? documentRef.body;
    let disposed = false, scheduled = false;
    const release = control => {
        control.controller?.abort();
        if (control.onCatalogSelection) control.select.removeEventListener('change', control.onCatalogSelection, true);
        control.refreshButton?.remove();
        control.status?.remove();
        if (control.source === 'vertexai') clearVertexModelCatalog(control.select);
        control.button.remove();
        if (control.row.parentNode) control.row.replaceWith(...control.row.childNodes);
        controls.delete(control.source);
    };
    async function refreshModels(source) {
        const state = controls.get(source);
        if (disposed || !state?.refreshButton || state.controller) return;
        const context = getModelContext();
        const controller = new AbortController();
        state.controller = controller;
        state.refreshButton.disabled = true;
        state.refreshButton.setAttribute('aria-busy', 'true');
        state.refreshButton.querySelector('i')?.classList.add('fa-spin');
        state.status.textContent = '正在拉取模型目录…';
        try {
            const entries = await onRefresh(source, { signal: controller.signal });
            if (disposed || controller.signal.aborted || controls.get(source) !== state) return;
            if (context !== getModelContext()) {
                state.status.textContent = '连接设置已变更，请重新拉取模型。';
                return;
            }
            projectVertexModelCatalog(state.select, entries);
            state.status.textContent = `已更新 ${entries.length} 个 Google 模型；当前模型保持不变。`;
        } catch (error) {
            if (!disposed && !controller.signal.aborted && controls.get(source) === state) state.status.textContent = error?.message || '模型目录拉取失败，请重试。';
        } finally {
            if (state.controller === controller) {
                state.controller = null;
                state.refreshButton.disabled = false;
                state.refreshButton.setAttribute('aria-busy', 'false');
                state.refreshButton.querySelector('i')?.classList.remove('fa-spin');
            }
        }
    }
    function refresh() {
        if (disposed) return;
        observer?.disconnect();
        try {
            for (const [source, config] of Object.entries(CUSTOM_MODEL_SOURCES)) {
                const select = documentRef.querySelector(config.selector);
                const current = controls.get(source);
                if (current?.select === select && select.parentElement === current.row && current.row.isConnected) continue;
                if (current) release(current);
                if (!select?.parentElement) continue;
                const companions = [];
                for (let next = select.nextElementSibling; next && (next.classList.contains('cw-picker') || next.classList.contains('select2-container')); next = next.nextElementSibling) companions.push(next);
                const row = documentRef.createElement('div');
                row.className = 'cw-native-model-row';
                const control = button('自定义模型', async () => {
                    try { await onOpen(source); } catch (error) { onError(error); }
                }, 'cw-model-button');
                control.dataset.cwModelButton = '';
                select.before(row);
                row.append(select, ...companions, control);
                const state = { source, select, row, button: control };
                if (source === 'vertexai' && typeof onRefresh === 'function') {
                    state.onCatalogSelection = () => {
                        const option = select.selectedOptions?.[0];
                        if (!option?.hasAttribute('data-cw-vertex-model') || typeof onSelectCatalog !== 'function') return;
                        try { onSelectCatalog(source, { id: option.value, label: option.textContent }); }
                        catch (error) { onError(error); }
                    };
                    select.addEventListener('change', state.onCatalogSelection, true);
                    state.refreshButton = button('拉取模型', () => refreshModels(source), 'cw-model-button');
                    state.refreshButton.dataset.cwModelRefresh = '';
                    state.status = documentRef.createElement('small');
                    state.status.className = 'cw-note cw-native-model-status';
                    state.status.setAttribute('role', 'status');
                    state.status.setAttribute('aria-live', 'polite');
                    row.append(state.refreshButton);
                    row.after(state.status);
                }
                controls.set(source, state);
            }
        } finally {
            if (!disposed) observer?.observe(observationRoot, { childList: true, subtree: true });
        }
    }
    const observer = typeof Observer === 'function' ? new Observer(records => {
        if (scheduled || disposed || !records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
            && (node.matches?.('select[id^="model_"], .cw-picker, .select2-container, .cw-native-model-row') || node.querySelector?.('select[id^="model_"]'))))) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            try { refresh(); } catch (error) { onError(error); }
        });
    }) : null;
    const onConnect = event => {
        if (!onRefresh || getSource() !== 'vertexai' || !event.target.closest?.('#api_button_openai')) return;
        queueMicrotask(() => { if (!disposed && getSource() === 'vertexai') void refreshModels('vertexai'); });
    };
    documentRef.addEventListener('click', onConnect, true);
    refresh();
    return {
        refresh, refreshModels,
        cleanup() {
            disposed = true;
            documentRef.removeEventListener('click', onConnect, true);
            observer?.disconnect();
            for (const control of [...controls.values()]) release(control);
        },
    };
}
