import { CUSTOM_MODEL_SOURCES } from './custom.js';

const LEGACY_PROVIDER = Object.freeze({ openai: 'openai', claude: 'claude', makersuite: 'google' });
const LEGACY_GROUP_ATTRIBUTE = 'data-connection-workbench-legacy-models';

function nativeMetadata(source) {
    if (!Object.hasOwn(CUSTOM_MODEL_SOURCES, source)) throw new Error('此来源没有可扩展的原生模型下拉框。');
    return CUSTOM_MODEL_SOURCES[source];
}

function legacyArray(extensionSettings, source) {
    const provider = Object.hasOwn(LEGACY_PROVIDER, source) ? LEGACY_PROVIDER[source] : null;
    const saved = provider && extensionSettings?.customModels?.provider?.[provider];
    return Array.isArray(saved) ? saved : null;
}

// getSettings returns all extension_settings; neither registry is migrated or changed.
export function listMergedModels(models, getSettings, source) {
    nativeMetadata(source);
    const result = new Map();
    for (const entry of models.list(source)) {
        if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
        result.set(entry.id, { id: entry.id, label: entry.label || entry.id, owned: true, legacy: false });
    }
    for (const id of legacyArray(getSettings(), source) ?? []) {
        if (typeof id !== 'string' || !id) continue;
        const entry = result.get(id);
        if (entry) entry.legacy = true;
        else result.set(id, { id, label: id, owned: false, legacy: true });
    }
    return [...result.values()];
}

function legacyGroups(select, source, before) {
    if (!select) return [];
    const groups = [...select.children].filter(child => child.tagName === 'OPTGROUP');
    const marked = groups.filter(group => group.getAttribute(LEGACY_GROUP_ATTRIBUTE) === source);
    if (marked.length) return marked;
    // Custom Models 1.3.0 has no ownership attribute. Match its exact list as well
    // as its label; never remove an arbitrary group's matching model ID.
    const matches = groups.filter(group => group.label === 'Custom Models'
        && group.children.length === before.length
        && [...group.children].every((option, index) => option.tagName === 'OPTION' && option.value === before[index]));
    return matches.length === 1 ? matches : [];
}

// Splice the legacy array in place: the older plugin retains it in event-handler closures.
export function removeMergedModel(models, source, id, { extensionSettings, documentRef = globalThis.document,
    chatCompletionSettings, saveSettings = () => {} } = {}) {
    const metadata = nativeMetadata(source);
    if (typeof id !== 'string' || !id) throw new Error('请选择要删除的模型。');
    const saved = legacyArray(extensionSettings, source);
    const before = saved ? [...saved] : [];
    const hadLegacy = before.includes(id);
    const select = documentRef?.querySelector(metadata.selector);
    const activeBefore = select?.value === id || chatCompletionSettings?.[metadata.field] === id;
    const groups = hadLegacy ? legacyGroups(select, source, before) : [];
    if (hadLegacy) {
        for (let index = saved.length - 1; index >= 0; index--) if (saved[index] === id) saved.splice(index, 1);
        for (const group of groups) for (const option of [...group.children]) {
            if (option.tagName === 'OPTION' && option.value === id) option.remove();
        }
    }
    const hadOwned = models.remove(source, id);
    if (!hadLegacy && !hadOwned) return false;

    let selectionChanged = false;
    const stillPresent = select && [...select.options].some(option => option.value === id);
    if (activeBefore && !stillPresent) {
        const available = select && [...select.options].filter(option => option.value && !option.disabled && !option.parentElement?.disabled);
        const fallback = available?.find(option => option.value === select.value)?.value ?? available?.[0]?.value ?? '';
        if (select) {
            select.value = fallback;
            const EventClass = documentRef.defaultView?.Event ?? globalThis.Event;
            select.dispatchEvent(new EventClass('change', { bubbles: true }));
        }
        // Older Custom Models stops propagation; explicitly synchronize the final
        // dropdown value so the deleted ID cannot remain in generation settings.
        if (chatCompletionSettings) chatCompletionSettings[metadata.field] = select?.value ?? fallback;
        selectionChanged = true;
    }
    if (hadLegacy) {
        const provider = LEGACY_PROVIDER[source];
        // The change handler may replace extension_settings.customModels with its
        // own root object. Update the current object after that handler has run.
        const currentLegacy = extensionSettings?.customModels;
        if (currentLegacy?.[`${provider}_model`] === id) {
            currentLegacy[`${provider}_model`] = select?.value ?? chatCompletionSettings?.[metadata.field] ?? '';
        }
    }
    if (hadLegacy || selectionChanged) saveSettings();
    return true;
}
