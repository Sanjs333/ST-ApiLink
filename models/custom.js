

/** Native model dropdown additions. This module never changes the API source. */
export const CUSTOM_MODEL_SOURCES = Object.freeze(Object.fromEntries([
    ['openai', 'OpenAI', 'openai'],
    ['claude', 'Claude', 'claude'],
    ['makersuite', 'Google AI Studio', 'google'],
    ['vertexai', 'Google Vertex AI', 'vertexai'],
    ['openrouter', 'OpenRouter', 'openrouter'],
    ['ai21', 'AI21', 'ai21'],
    ['mistralai', 'Mistral AI', 'mistralai'],
    ['cohere', 'Cohere', 'cohere'],
    ['perplexity', 'Perplexity', 'perplexity'],
    ['groq', 'Groq', 'groq'],
    ['siliconflow', 'SiliconFlow', 'siliconflow'],
    ['minimax', 'MiniMax', 'minimax'],
    ['electronhub', 'Electron Hub', 'electronhub'],
    ['chutes', 'Chutes', 'chutes'],
    ['nanogpt', 'NanoGPT', 'nanogpt'],
    ['workers_ai', 'Cloudflare Workers AI', 'workers_ai'],
    ['deepseek', 'DeepSeek', 'deepseek'],
    ['fireworks', 'Fireworks AI', 'fireworks'],
    ['cometapi', 'CometAPI', 'cometapi'],
    ['xai', 'xAI', 'xai'],
    ['aimlapi', 'AI/ML API', 'aimlapi'],
    ['pollinations', 'Pollinations', 'pollinations'],
    ['moonshot', 'Moonshot AI', 'moonshot'],
    ['zai', 'Z.AI', 'zai'],
].map(([source, label, native]) => [source, Object.freeze({
    label,
    selector: `#model_${native}_select`,
    field: `${native}_model`,
})])));

const MODEL_ATTRIBUTE = 'data-connection-workbench-models';
const MODEL_SELECTORS = Object.values(CUSTOM_MODEL_SOURCES).map(config => config.selector).join(',');
const MODEL_SOURCE_BY_ID = new Map(Object.entries(CUSTOM_MODEL_SOURCES).map(([source, config]) => [config.selector.slice(1), source]));

function modelEntry(id, label = id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 512 || /[\x00-\x1f\x7f]/u.test(id)) {
        throw new Error('请输入有效的模型 ID（最多 512 个字符）。');
    }
    if (typeof label !== 'string' || (label !== id && label.length > 256) || /[\x00-\x1f\x7f]/u.test(label)) {
        throw new Error('模型显示名称最多 256 个字符，不能包含控制字符。');
    }
    return { id: id.trim(), label: label.trim() || id.trim() };
}

// getSettings returns extension_settings.connectionWorkbench.
export function installCustomModels({ getSettings, saveSettings, onError = () => {}, initialSettings = null,
    documentRef = globalThis.document, getContext = () => globalThis.SillyTavern?.getContext?.(),
    Observer = globalThis.MutationObserver, jQueryRef = documentRef?.defaultView?.jQuery ?? globalThis.jQuery } = {}) {
    if (typeof getSettings !== 'function' || typeof saveSettings !== 'function' || !documentRef) {
        throw new Error('自定义模型需要酒馆设置和页面接口。');
    }
    let disposed = false, scheduled = false;
    const pendingSources = new Set();
    const observationRoot = documentRef.querySelector('#rm_api_block') ?? documentRef.body;
    const attached = new Map(), preferred = new Map(), revisions = new Map(), subscriptions = [];
    const ownedOptions = new Set();
    const report = error => { try { onError(error); } catch { /* Error presentation cannot break the host. */ } };
    const metadata = source => {
        if (!Object.hasOwn(CUSTOM_MODEL_SOURCES, source)) throw new Error('此来源没有可扩展的原生模型下拉框。');
        return CUSTOM_MODEL_SOURCES[source];
    };
    const runtime = () => getContext()?.chatCompletionSettings;
    function list(source) {
        metadata(source);
        const saved = getSettings()?.models?.[source];
        if (!Array.isArray(saved)) return [];
        const entries = new Map();
        for (const item of saved) {
            try {
                const entry = typeof item === 'string' ? modelEntry(item) : modelEntry(item?.id, item?.label ?? item?.id);
                entries.set(entry.id, entry);
            } catch { /* Invalid imported rows do not prevent the remaining additions from loading. */ }
        }
        return [...entries.values()];
    }
    const registered = (source, id) => list(source).some(item => item.id === id);
    const bump = source => { const next = (revisions.get(source) ?? 0) + 1; revisions.set(source, next); return next; };
    function assign(source, id, select) {
        const settings = runtime();
        if (!settings) return;
        const field = metadata(source).field;
        if (settings[field] !== id) {
            settings[field] = id;
            saveSettings();
        }
        // Claude's native handler rewrites '-v' IDs and older names. Only our explicit
        // additions receive this correction; normal provider models keep native behavior.
        if (select && select.value !== id && [...select.options].some(option => option.value === id)) select.value = id;
    }
    function dispatch(select) {
        const EventClass = documentRef.defaultView?.Event ?? globalThis.Event;
        select.dispatchEvent(new EventClass('change', { bubbles: true }));
    }
    function detach(source) {
        const prior = attached.get(source);
        if (!prior) return;
        prior.select.removeEventListener('change', prior.handler, true);
        prior.jquerySelect?.off('change.connectionWorkbenchModels', prior.syntheticHandler);
        attached.delete(source);
    }
    function attach(source, select) {
        const prior = attached.get(source);
        if (prior?.select === select) return;
        detach(source);
        const handler = event => {
            const id = select.value;
            const desired = preferred.get(source);
            // A rebuilt native list temporarily omits our additions. Its synthetic
            // fallback change must not replace the model that will be reinserted.
            if (desired && id !== desired && !event?.isTrusted
                && ![...select.options].some(option => option.value === desired)) {
                pendingSources.add(source);
                schedule();
                return;
            }
            const revision = bump(source);
            if (!registered(source, id)) { preferred.delete(source); return; }
            preferred.set(source, id);
            assign(source, id);
            // Capture precedes legacy Custom Models' stopImmediatePropagation. Wait until
            // native handlers finish before restoring an ID they normalize or ignore.
            queueMicrotask(() => {
                if (!disposed && revisions.get(source) === revision && preferred.get(source) === id) {
                    try { assign(source, id, select); } catch (error) { report(error); }
                }
            });
        };
        select.addEventListener('change', handler, true);
        // Native capture listeners do not receive jQuery's .trigger('change'),
        // which the host uses for /model and connection profiles. Native events
        // have already been handled in capture and must not be processed twice.
        const jquerySelect = typeof jQueryRef === 'function' ? jQueryRef(select) : null;
        const syntheticHandler = event => { if (!event.originalEvent) handler(event); };
        jquerySelect?.on('change.connectionWorkbenchModels', syntheticHandler);
        attached.set(source, { select, handler, jquerySelect, syntheticHandler });
    }
    function project(source) {
        const select = documentRef.querySelector(metadata(source).selector);
        if (!select) {
            detach(source);
            return;
        }
        attach(source, select);
        const entries = list(source), allowed = new Set(entries.map(item => item.id));
        const selected = select.selectedOptions?.[0];
        const ownOptions = new Map();
        for (const option of ownedOptions) {
            if (!option.isConnected) { ownedOptions.delete(option); continue; }
            if (option.closest('select') !== select) continue;
            if (!allowed.has(option.value)) { option.remove(); ownedOptions.delete(option); continue; }
            if (!ownOptions.has(option.value)) ownOptions.set(option.value, option);
        }
        const existing = new Set([...select.options].map(option => option.value));
        const insertionPoint = [...select.children].find(node => node.tagName !== 'OPTION' || node.value) ?? null;
        for (const entry of entries) {
            if (existing.has(entry.id)) {
                const own = ownOptions.get(entry.id);
                if (own && own.textContent !== entry.label) own.textContent = entry.label;
                continue;
            }
            const option = documentRef.createElement('option');
            option.value = entry.id;
            option.textContent = entry.label;
            option.setAttribute(MODEL_ATTRIBUTE, source);
            ownedOptions.add(option);
            select.insertBefore(option, insertionPoint);
            existing.add(entry.id);
        }
        if (selected?.closest('select') === select && !selected.selected) select.selectedIndex = [...select.options].indexOf(selected);
        const desired = preferred.get(source);
        if (desired && allowed.has(desired)) {
            if (select.value !== desired || runtime()?.[metadata(source).field] !== desired) {
                select.value = desired;
                dispatch(select);
                assign(source, desired, select);
            }
        }
    }
    function collectChanges(records, sources) {
        const add = node => {
            const source = MODEL_SOURCE_BY_ID.get(node?.id);
            if (source) sources.add(source);
            return source;
        };
        for (const record of records) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (add(target?.closest?.(MODEL_SELECTORS))) continue;
            for (const node of [...record.addedNodes, ...(record.removedNodes ?? [])]) {
                if (node.nodeType !== 1) continue;
                if (add(node)) continue;
                if (node.querySelectorAll) for (const select of node.querySelectorAll(MODEL_SELECTORS)) add(select);
                else for (const config of Object.values(CUSTOM_MODEL_SOURCES)) add(node.querySelector?.(config.selector));
            }
        }
    }
    function refresh(sources = Object.keys(CUSTOM_MODEL_SOURCES)) {
        if (disposed) return;
        const changed = new Set([...sources, ...pendingSources]);
        collectChanges(observer?.takeRecords?.() ?? [], changed);
        pendingSources.clear();
        observer?.disconnect();
        try { for (const source of changed) project(source); }
        finally { if (!disposed) observer?.observe(observationRoot, { childList: true, subtree: true }); }
    }
    function schedule() {
        if (disposed || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            if (!disposed && pendingSources.size) try { refresh(pendingSources); } catch (error) { report(error); }
        });
    }
    const observer = typeof Observer === 'function' ? new Observer(records => {
        if (disposed) return;
        collectChanges(records, pendingSources);
        if (pendingSources.size) schedule();
    }) : null;
    function synchronizeSelections(settings = runtime()) {
        if (disposed) return;
        for (const [source, config] of Object.entries(CUSTOM_MODEL_SOURCES)) {
            bump(source);
            const id = settings?.[config.field] ?? runtime()?.[config.field];
            if (registered(source, id)) preferred.set(source, id);
            else preferred.delete(source);
        }
        refresh();
    }
    const context = getContext();
    for (const name of ['SETTINGS_LOADED', 'CONNECTION_PROFILE_LOADED', 'OAI_PRESET_CHANGED_AFTER', 'CHATCOMPLETION_SOURCE_CHANGED']) {
        const event = context?.eventTypes?.[name];
        if (event && typeof context.eventSource?.on === 'function') {
            const handler = () => synchronizeSelections();
            context.eventSource.on(event, handler);
            subscriptions.push(() => context.eventSource.removeListener(event, handler));
        }
    }
    // A saved custom ID may already have been cleared by the native startup handler.
    synchronizeSelections(initialSettings ?? runtime());
    function upsert(source, id, label, selectModel) {
        if (disposed) throw new Error('自定义模型管理已停用。');
        const entry = modelEntry(id, label ?? id);
        const entries = list(source).filter(item => item.id !== entry.id);
        entries.push(entry);
        const settings = getSettings();
        if (!settings.models || typeof settings.models !== 'object' || Array.isArray(settings.models)) settings.models = {};
        settings.models[source] = entries;
        if (selectModel && runtime()?.chat_completion_source === source) preferred.set(source, entry.id);
        saveSettings();
        refresh([source]);
        return { ...entry };
    }
    return {
        synchronizeSelections,
        add(source, id, label) { return upsert(source, id, label, true); },
        ensureOption(source, id, label) { return upsert(source, id, label, false); },
        select(source, id) {
            if (runtime()?.chat_completion_source !== source) throw new Error('请先切换到这个补全来源，再选择模型。');
            const existing = list(source).find(item => item.id === id);
            return upsert(source, id, existing?.label, true);
        },
        clearSelection(source) {
            metadata(source);
            preferred.delete(source);
            bump(source);
        },
        remove(source, id) {
            if (disposed) throw new Error('自定义模型管理已停用。');
            const entries = list(source), next = entries.filter(item => item.id !== id);
            if (next.length === entries.length) return false;
            const select = documentRef.querySelector(metadata(source).selector);
            const selected = select?.value === id;
            getSettings().models[source] = next;
            if (preferred.get(source) === id) preferred.delete(source);
            bump(source);
            saveSettings();
            refresh([source]);
            if (selected && select?.value !== id) dispatch(select);
            return true;
        },
        list,
        cleanup() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            for (const unsubscribe of subscriptions) unsubscribe();
            for (const source of attached.keys()) detach(source);
            for (const option of ownedOptions) option.remove();
            ownedOptions.clear(); attached.clear(); preferred.clear(); pendingSources.clear();
        },
    };
}
