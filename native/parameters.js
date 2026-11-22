import { createParameterPresetControls } from '../parameters/editor.js';
import { touchesSelector } from './mutations.js';

const HIDDEN_CLASS = 'cw-native-parameter-entry-hidden';

export function installNativeParameterPresets({ store, getSource, readFields, writeFields, root = document, onError } = {}) {
    const documentRef = root.ownerDocument ?? root;
    const windowRef = documentRef.defaultView;
    const controls = createParameterPresetControls({ store, readFields, writeFields, onError });
    controls.root.classList.add('cw-native-parameter-presets');
    controls.root.id = 'connection-workbench-parameter-presets';
    const nativeEntries = new Map();
    let stopped = false, timer = null;
    function scan() {
        if (stopped) return;
        const form = root.querySelector('#custom_form');
        if (form && controls.root.parentElement !== form) form.append(controls.root);
        controls.root.hidden = getSource() !== 'custom';
        for (const entry of root.querySelectorAll('#customize_additional_parameters')) {
            if (!nativeEntries.has(entry)) nativeEntries.set(entry, entry.classList.contains(HIDDEN_CLASS));
            entry.classList.add(HIDDEN_CLASS);
        }
    }
    function refresh(options) { scan(); controls.refresh(options); }
    const onClick = event => {
        const entry = event.target.closest?.('#customize_additional_parameters');
        if (stopped || !entry || !root.contains(entry) || getSource() !== 'custom') return;
        event.preventDefault(); event.stopImmediatePropagation();
        void controls.openEditor().catch(error => onError?.(error));
    };
    documentRef.addEventListener('click', onClick, true);
    const observer = new windowRef.MutationObserver(records => {
        if (stopped || timer !== null) return;
        const selector = '#custom_form, #customize_additional_parameters';
        if (!records.some(record => touchesSelector(record, selector))) return;
        timer = windowRef.setTimeout(() => { timer = null; refresh({ resetSelection: true }); }, 0);
    });
    observer.observe(root.querySelector('#rm_api_block') ?? (root.nodeType === 9 ? root.body : root), { childList: true, subtree: true });
    refresh({ resetSelection: true });
    return { refresh, cleanup() {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        if (timer !== null) windowRef.clearTimeout(timer);
        documentRef.removeEventListener('click', onClick, true);
        controls.cleanup(); controls.root.remove();
        for (const [entry, wasHidden] of nativeEntries) entry.classList.toggle(HIDDEN_CLASS, wasHidden);
        nativeEntries.clear();
    } };
}
