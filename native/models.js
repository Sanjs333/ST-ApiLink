import { CUSTOM_MODEL_SOURCES } from '../models/custom.js';
import { button } from '../ui/common.js';

export function installNativeModelControls({ onOpen, onError = console.error, documentRef = globalThis.document,
    Observer = globalThis.MutationObserver } = {}) {
    const controls = new Map();
    const observationRoot = documentRef.querySelector('#rm_api_block') ?? documentRef.body;
    let disposed = false, scheduled = false;
    const release = control => {
        control.button.remove();
        if (control.row.parentNode) control.row.replaceWith(...control.row.childNodes);
        controls.delete(control.source);
    };
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
                controls.set(source, { source, select, row, button: control });
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
    refresh();
    return {
        refresh,
        cleanup() {
            disposed = true;
            observer?.disconnect();
            for (const control of [...controls.values()]) release(control);
        },
    };
}
