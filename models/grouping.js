

const MODEL_SELECTOR = '#openai_api select[id^="model_"][id$="_select"],#rm_api_block select[id^="model_"][id$="_select"]';
const OWN_GROUP = 'data-cw-auto-model-group';
const FAMILIES = [
    ['Claude', /^(?:anthropic[/:])?claude(?:[-_.:/]|$)/i],
    ['Gemini', /^(?:google[/:])?(?:gemini|gemma)(?:[-_.:/]|$)/i],
    ['OpenAI', /^(?:openai[/:])?(?:gpt(?:[-_.:/]|$)|chatgpt(?:[-_.:/]|$)|o\d+(?:[-_.:/]|$)|text-embedding(?:[-_.:/]|$)|dall-e(?:[-_.:/]|$)|whisper(?:[-_.:/]|$)|tts(?:[-_.:/]|$))/i],
    ['DeepSeek', /^(?:deepseek[/:])?deepseek(?:[-_.:/]|$)/i],
    ['Qwen', /^(?:qwen[/:])?(?:qwen\d*|qwq|qvq)(?:[-_.:/]|$)/i],
    ['GLM', /^(?:zhipu[/:])?(?:chatglm|glm)(?:[-_.:/]|$)/i],
    ['Llama', /^(?:meta(?:-llama)?[/:])?llama\d*(?:[-_.:/]|$)/i],
    ['Mistral', /^(?:mistralai[/:])?(?:mistral|mixtral|codestral|pixtral|ministral|magistral)(?:[-_.:/]|$)/i],
    ['Grok', /^(?:x-ai[/:])?grok(?:[-_.:/]|$)/i],
];

/** Infer a model family without treating ordinary hyphens or version dates as groups. */
export function modelFamily(id) {
    const text = String(id ?? '').replace(/^(?:\[[^\]]+\]|【[^】]+】)/, '').replace(/^models\//i, '');
    return FAMILIES.find(([, pattern]) => pattern.test(text))?.[0] ?? '其他';
}

function relayParts(id) {
    const wrapped = id.match(/^(?:\[([^\]\r\n]{1,96})\]|【([^】\r\n]{1,96})】|\(([^)\r\n]{1,96})\)|（([^）\r\n]{1,96})）|\{([^}\r\n]{1,96})\}|〈([^〉\r\n]{1,96})〉|「([^」\r\n]{1,96})」|『([^』\r\n]{1,96})』)(?:\s*[/：:|_-]\s*|\s*)(.+)$/);
    if (wrapped) return { prefix: (wrapped.slice(1, 9).find(Boolean) ?? '').trim(), model: wrapped[9].trim() };
    const path = id.match(/^([^\[\]【】()（）{}〈〉/:|：\s_-]{1,96})\s*[/：:|]\s*(.+)$/);
    if (path && !/^(?:models?|https?)$/i.test(path[1]) && modelFamily(path[1]) === '其他') return { prefix: path[1], model: path[2].trim() };
    // A relay may use a hyphen/underscore, but only split before a known family.
    const named = id.match(/^(.{1,96}?)[-_]((?:claude|gemini|gemma|gpt|chatgpt|o\d+|deepseek|qwen\d*|qwq|qvq|glm|chatglm|llama\d*|mistral|grok)(?:[-_.:/]|$).*)$/i);
    if (named && modelFamily(named[1]) === '其他') return { prefix: named[1], model: named[2] };
    return null;
}

function prefixIdentity(prefix) {
    return prefix.trim().replace(/^[\[\]【】()（）{}〈〉<>@#$%^&*!~`]+|[\[\]【】()（）{}〈〉<>@#$%^&*!~`]+$/g, '')
        .replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Group suggestions automatically; preserve IDs, labels and caller fields exactly. */
export function groupModelEntries(items) {
    const prefixes = new Map();
    const prepared = items.map(item => {
        const id = String(item.id ?? '');
        const relay = item.group ? null : relayParts(id);
        const prefix = relay?.prefix ?? null;
        if (prefix) {
            const prefixKey = prefixIdentity(prefix);
            if (prefixKey && !prefixes.has(prefixKey)) prefixes.set(prefixKey, { display: prefix.trim().replace(/^[\[\]【】()（）{}〈〉<>@#$%^&*!~`]+|[\[\]【】()（）{}〈〉<>@#$%^&*!~`]+$/g, ''), ids: new Set() });
            if (prefixKey) prefixes.get(prefixKey).ids.add(id);
        }
        return { item, id, prefix, relayModel: relay?.model ?? '', prefixKey: prefix ? prefixIdentity(prefix) : '' };
    });
    const groups = new Map();
    for (const { item, id, prefix, relayModel, prefixKey } of prepared) {
        const family = modelFamily(id);
        const candidates = [...id.split(/[/:]/), ...(relayModel ? [relayModel] : [])];
        const nestedFamily = family !== '其他' ? family : candidates.map(modelFamily).find(value => value !== '其他') ?? '其他';
        const prefixGroup = prefixKey && prefixes.get(prefixKey);
        const group = item.group || (prefixGroup?.ids?.size > 1 ? prefixGroup.display : nestedFamily);
        const key = item.groupKey ?? group;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...item, group, groupKey: key });
    }
    // A single family has nothing to organize; keep a short list visually quiet.
    const showGroups = groups.size > 1 || prepared.some(({ item, prefixKey }) => item.group || (prefixKey && prefixes.get(prefixKey)?.ids?.size > 1));
    return [...groups.values()].flat().map(item => ({ ...item, group: showGroups ? item.group : '' }));
}

/** Project automatic groups into native model selects without changing option ownership or events. */
export function installNativeModelGrouping({ root = document, onError = console.error, groupedSelectors = [] } = {}) {
    const documentRef = root.ownerDocument ?? root;
    const windowRef = documentRef.defaultView;
    const explicitSelectors = Array.isArray(groupedSelectors) ? groupedSelectors.join(',') : groupedSelectors;
    const observedSelectors = explicitSelectors ? `${MODEL_SELECTOR},${explicitSelectors}` : MODEL_SELECTOR;
    const states = new Map();
    let stopped = false, timer = null, activeSelect = null;
    const styledMenus = new Map();
    const styledControls = new Map();
    const styledSelectControls = new Map();
    const observe = () => observer.observe(root, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['value', 'label', 'hidden', 'class', 'disabled', 'data-st-select-styler-processed'], characterData: true });
    const report = error => { try { onError?.(error); } catch { /* UI reporters cannot interrupt cleanup. */ } };
    const sameNodes = (actual, desired) => actual.length === desired.length && actual.every((node, index) => node === desired[index]);

    function project(select) {
        let state = states.get(select);
        if (state && !state.dirty) return;
        if (!state) { state = { order: new Map(), next: 0, groups: new Map() }; states.set(select, state); }
        const eligible = [], outsiders = [];
        for (const node of [...select.children]) {
            if (node.tagName === 'OPTGROUP' && node.hasAttribute(OWN_GROUP)) eligible.push(...node.children);
            else if (node.tagName === 'OPTION') eligible.push(node);
            else outsiders.push(node);
        }
        const present = new Set([...eligible, ...outsiders]);
        for (const node of state.order.keys()) if (!present.has(node)) state.order.delete(node);
        for (const node of [...select.children].flatMap(node => node.hasAttribute(OWN_GROUP) ? [...node.children] : [node])) {
            if (!state.order.has(node)) state.order.set(node, state.next++);
        }
        eligible.sort((a, b) => state.order.get(a) - state.order.get(b));
        const selected = select.selectedOptions?.[0] ?? [...select.options].find(option => option.selected);
        const placeholders = eligible.filter(option => !option.value);
        const entries = groupModelEntries(eligible.filter(option => option.value).map(option => ({ id: option.value, option })));
        const desired = [...placeholders], used = new Map();
        for (const entry of entries) {
            if (!entry.group) { desired.push(entry.option); continue; }
            let group = state.groups.get(entry.groupKey);
            if (!group) {
                group = documentRef.createElement('optgroup'); group.label = entry.group;
                group.setAttribute(OWN_GROUP, ''); state.groups.set(entry.groupKey, group);
            }
            if (!used.has(group)) { used.set(group, []); desired.push(group); }
            used.get(group).push(entry.option);
        }
        desired.push(...outsiders);
        for (const [group, options] of used) if (!sameNodes([...group.children], options)) group.replaceChildren(...options);
        if (!sameNodes([...select.children], desired)) select.replaceChildren(...desired);
        for (const [key, group] of state.groups) if (!used.has(group)) state.groups.delete(key);
        if (selected && selected.closest('select') === select && !selected.selected) select.selectedIndex = [...select.options].indexOf(selected);
        state.dirty = false;
    }

    // Select Styler uses its own saved groups and ignores optgroup. Add automatic
    // groups only to its otherwise ungrouped rows, retaining its search and handlers.
    function projectStyledMenu() {
        if (!activeSelect?.isConnected || !activeSelect.hasAttribute('data-st-select-styler-processed')) return;
        const menuSelect = activeSelect;
        const container = documentRef.querySelector('.gr-container-enhanced.open .gr-options-container');
        if (!container || container.querySelector('[data-cw-styled-model-group]')) return;
        const rows = [...container.children].filter(node => node.classList.contains('gr-option') && node.dataset.value);
        if (!rows.length) return;
        const optionGroups = new Map([...activeSelect.options].map(option => [option.value,
            option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '']));
        const suggestions = rows.map(row => ({ id: row.dataset.value, row,
            group: optionGroups.get(row.dataset.value) || undefined }));
        const entries = activeSelect.matches(MODEL_SELECTOR) ? groupModelEntries(suggestions)
            : suggestions.map(entry => ({ ...entry, groupKey: entry.group }));
        if (!entries.some(entry => entry.group)) return;
        const old = [...container.children], groups = new Map(), added = [], childClasses = new Map();
        const ungrouped = old.find(node => node.classList.contains('gr-group-label'));
        const marker = documentRef.createElement('span'); marker.hidden = true;
        container.insertBefore(marker, ungrouped ?? rows[0]);
        for (const entry of entries) {
            if (!entry.group) continue;
            if (!groups.has(entry.groupKey)) {
                const heading = documentRef.createElement('div');
                heading.className = 'gr-option-group-header cw-styled-auto-model-group';
                heading.setAttribute('data-cw-styled-model-group', '');
                heading.dataset.cwStyledGroupKey = String(entry.groupKey);
                const arrow = documentRef.createElement('span'); arrow.className = 'gr-group-arrow';
                const icon = documentRef.createElement('i'); icon.className = 'fa-solid fa-angle-right'; arrow.append(icon);
                const title = documentRef.createElement('span'); title.textContent = entry.group;
                const count = documentRef.createElement('span'); count.className = 'gr-group-badge';
                heading.append(arrow, title, count);
                const items = documentRef.createElement('div'); items.className = 'gr-option-group-items cw-styled-auto-model-items';
                const remembered = styledSelectControls.get(menuSelect)?.collapsed.get(String(entry.groupKey));
                if (remembered) { heading.classList.add('collapsed'); items.classList.add('collapsed'); }
                heading.addEventListener('click', event => {
                    event.stopPropagation(); const collapsed = !heading.classList.contains('collapsed');
                    heading.classList.toggle('collapsed', collapsed); items.classList.toggle('collapsed', collapsed);
                    styledSelectControls.get(menuSelect)?.collapsed.set(String(entry.groupKey), collapsed);
                });
                container.insertBefore(heading, marker); container.insertBefore(items, marker);
                groups.set(entry.groupKey, { heading, items, count }); added.push(heading, items);
            }
            const group = groups.get(entry.groupKey);
            childClasses.set(entry.row, entry.row.classList.contains('cw-picker-group-child'));
            entry.row.classList.add('cw-picker-group-child');
            group.items.append(entry.row);
            group.count.textContent = String(group.items.children.length);
        }
        marker.remove();
        const wasHidden = ungrouped?.hidden;
        if (ungrouped && rows.every(row => row.parentElement !== container)) ungrouped.hidden = true;
        styledMenus.set(container, { old, added, ungrouped, wasHidden, childClasses });
    }

    const styledGroupPairs = container => [...container.querySelectorAll('.gr-option-group-header')].map(heading => ({ heading, items: heading.nextElementSibling }))
        .filter(({ items }) => items?.classList.contains('gr-option-group-items'));

    function updateStyledControl(state) {
        const groups = styledGroupPairs(state.container);
        const searching = Boolean(state.input?.value.trim());
        for (const { heading, items } of groups) {
            if (!state.attributes.has(heading)) state.attributes.set(heading,
                ['aria-expanded', 'aria-disabled'].map(name => [name, heading.getAttribute(name)]));
            if (searching) {
                if (!state.searchStates.has(heading)) state.searchStates.set(heading, { items,
                    headingCollapsed: heading.classList.contains('collapsed'), itemsCollapsed: items.classList.contains('collapsed') });
                heading.classList.remove('collapsed'); items.classList.remove('collapsed');
                heading.setAttribute('aria-disabled', 'true');
            } else {
                const previous = state.searchStates.get(heading);
                if (previous) {
                    heading.classList.toggle('collapsed', previous.headingCollapsed);
                    items.classList.toggle('collapsed', previous.itemsCollapsed);
                    state.searchStates.delete(heading);
                }
                const originalDisabled = state.attributes.get(heading).find(([name]) => name === 'aria-disabled')?.[1];
                if (originalDisabled === null) heading.removeAttribute('aria-disabled');
                else if (originalDisabled !== undefined) heading.setAttribute('aria-disabled', originalDisabled);
            }
            heading.setAttribute('aria-expanded', String(!items.classList.contains('collapsed')));
            if (!searching && heading.hasAttribute('data-cw-styled-model-group'))
                state.owner.collapsed.set(heading.dataset.cwStyledGroupKey, items.classList.contains('collapsed'));
        }
        for (const heading of state.attributes.keys()) if (!state.container.contains(heading)) {
            state.attributes.delete(heading); state.searchStates.delete(heading);
        }
        const visible = groups.filter(({ heading, items }) => !heading.hidden && !heading.classList.contains('hidden')
            && !items.hidden && !items.classList.contains('search-hidden'));
        const expand = visible.some(({ items }) => items.classList.contains('collapsed'));
        const title = expand ? '全部展开' : '全部收起';
        if (state.owner.menu !== state) return;
        state.owner.expand = expand;
        state.owner.icon.className = `fa-solid ${expand ? 'fa-expand' : 'fa-compress'}`;
        state.owner.button.title = title;
        state.owner.button.setAttribute('aria-label', title);
        state.owner.button.hidden = !groups.length;
        state.owner.button.disabled = searching || state.select.disabled || !visible.length;
    }

    function restoreStyledControl(state) {
        state.input?.removeEventListener('input', state.onInput);
        state.container.removeEventListener('click', state.onGroupClick, true);
        for (const [heading, previous] of state.searchStates) {
            heading.classList.toggle('collapsed', previous.headingCollapsed);
            previous.items.classList.toggle('collapsed', previous.itemsCollapsed);
        }
        for (const [heading, attributes] of state.attributes) for (const [name, value] of attributes) {
            if (value === null) heading.removeAttribute(name); else heading.setAttribute(name, value);
        }
        if (state.searchRow && !state.hadSearchRowClass) state.searchRow.classList.remove('cw-picker-search-row');
        if (state.owner.menu === state) {
            state.owner.menu = null;
            state.owner.row.append(state.owner.button);
            state.owner.button.hidden = true;
        }
    }

    function restoreStyledSelectControl(owner) {
        owner.button.remove();
        if (owner.select.parentElement === owner.row) owner.row.replaceWith(owner.select);
        else owner.row.remove();
    }

    function applyStyledGroupState(state, expanded) {
        const groups = styledGroupPairs(state.container).filter(({ heading, items }) => !heading.hidden && !heading.classList.contains('hidden')
            && !items.hidden && !items.classList.contains('search-hidden'));
        for (const { heading, items } of groups) if (items.classList.contains('collapsed') === expanded)
            heading.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
        updateStyledControl(state);
    }

    function installStyledSelectRows() {
        for (const [select, owner] of styledSelectControls) if (!select.isConnected || !select.hasAttribute('data-st-select-styler-processed')
            || select.multiple || select.parentElement !== owner.row) {
            restoreStyledSelectControl(owner); styledSelectControls.delete(select);
        }
        for (const select of root.querySelectorAll(observedSelectors)) {
            if (!select.hasAttribute('data-st-select-styler-processed') || select.multiple) continue;
            let owner = styledSelectControls.get(select);
            // An active picker already owns the row; moving only its native select separates the controls.
            if (!owner && select.classList.contains('cw-picker-native')) continue;
            if (!owner) {
                const row = documentRef.createElement('div'); row.className = 'cw-styled-select-row';
                if (select.classList.contains('flex1')) row.classList.add('flex1');
                const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'menu_button cw-picker-group-state';
                const icon = documentRef.createElement('i'); icon.setAttribute('aria-hidden', 'true'); button.append(icon);
                owner = { select, row, button, icon, menu: null, expand: false, pendingExpanded: null, collapsed: new Map() };
                select.replaceWith(row); row.append(select, button); styledSelectControls.set(select, owner);
                button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
                button.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
                button.addEventListener('click', event => {
                    event.preventDefault(); event.stopPropagation();
                    if (button.disabled || stopped) return;
                    const menu = owner.menu;
                    if (menu?.container.closest('.gr-container-enhanced')?.classList.contains('open')) {
                        applyStyledGroupState(menu, owner.expand);
                    } else {
                        owner.pendingExpanded = owner.expand;
                        activeSelect = select;
                        select.dispatchEvent(new windowRef.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                    }
                });
            }
            if (!owner.menu) {
                owner.button.hidden = true;
                owner.button.disabled = select.disabled;
                owner.icon.className = `fa-solid ${owner.expand ? 'fa-expand' : 'fa-compress'}`;
                owner.button.title = owner.expand ? '全部展开' : '全部收起';
                owner.button.setAttribute('aria-label', owner.button.title);
            }
        }
    }

    /** Reuse Styler's group click handlers and keep temporary search expansion out of saved settings. */
    function installStyledControls() {
        for (const [container, state] of styledControls) {
            if (!container.isConnected || state.input !== container.closest('.gr-options')?.querySelector('.gr-search-input')
                || !styledSelectControls.has(state.select)) {
                restoreStyledControl(state); styledControls.delete(container);
            } else updateStyledControl(state);
        }
        if (!activeSelect?.isConnected || !activeSelect.hasAttribute('data-st-select-styler-processed')) return;
        const container = documentRef.querySelector('.gr-container-enhanced.open .gr-options-container');
        if (!container || !styledGroupPairs(container).length) return;
        const existing = styledControls.get(container);
        if (existing) {
            if (existing.owner.pendingExpanded !== null && !existing.input?.value.trim()) {
                const expanded = existing.owner.pendingExpanded; existing.owner.pendingExpanded = null;
                applyStyledGroupState(existing, expanded);
            }
            return;
        }
        const input = container.closest('.gr-options')?.querySelector('.gr-search-input');
        const owner = styledSelectControls.get(activeSelect);
        if (!owner) return;
        const searchRow = input?.parentElement;
        const state = { container, select: activeSelect, input, owner, searchRow,
            hadSearchRowClass: searchRow?.classList.contains('cw-picker-search-row'), attributes: new Map(), searchStates: new Map() };
        owner.menu = state;
        if (searchRow) {
            searchRow.classList.add('cw-picker-search-row');
            searchRow.append(owner.button);
        }
        state.onInput = () => { if (!stopped) updateStyledControl(state); };
        state.onGroupClick = event => {
            if (state.input?.value.trim() && event.target.closest?.('.gr-option-group-header')) {
                event.preventDefault(); event.stopImmediatePropagation();
            }
        };
        input?.addEventListener('input', state.onInput);
        container.addEventListener('click', state.onGroupClick, true);
        styledControls.set(container, state);
        updateStyledControl(state);
        if (owner.pendingExpanded !== null && !input?.value.trim()) {
            const expanded = owner.pendingExpanded; owner.pendingExpanded = null;
            applyStyledGroupState(state, expanded);
        }
    }

    function refresh() {
        timer = null;
        if (stopped) return;
        observer.disconnect();
        try {
            for (const select of root.querySelectorAll(MODEL_SELECTOR)) project(select);
            for (const select of states.keys()) if (!select.isConnected) states.delete(select);
            for (const container of styledMenus.keys()) if (!container.isConnected || !container.querySelector('[data-cw-styled-model-group]')) styledMenus.delete(container);
            installStyledSelectRows();
            projectStyledMenu();
            installStyledControls();
        } catch (error) { report(error); }
        finally { if (!stopped) observe(); }
    }
    const observer = new windowRef.MutationObserver(records => {
        if (stopped) return;
        // Menu changes do not invalidate model inventories; only their native select does.
        for (const record of records) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            const select = target?.closest?.(MODEL_SELECTOR);
            if (states.has(select)) states.get(select).dirty = true;
            for (const node of record.addedNodes ?? []) {
                if (node.matches?.(MODEL_SELECTOR) && states.has(node)) states.get(node).dirty = true;
                for (const nested of node.querySelectorAll?.(MODEL_SELECTOR) ?? [])
                    if (states.has(nested)) states.get(nested).dirty = true;
            }
        }
        if (timer !== null) return;
        const relevant = records.some(record => {
            const target = record.target;
            return target.matches?.(observedSelectors) || target.closest?.(observedSelectors)
                || target.closest?.('.gr-container-enhanced')
                || [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])].some(node => node.matches?.(observedSelectors)
                    || node.querySelector?.(observedSelectors) || node.matches?.('.gr-container-enhanced') || node.querySelector?.('.gr-container-enhanced'));
        });
        if (relevant) timer = windowRef.setTimeout(refresh, 0);
    });
    const onOpen = event => {
        const select = event.target.closest?.('select');
        if (select) activeSelect = select.matches(observedSelectors) ? select : null;
    };
    for (const type of ['mousedown', 'touchend', 'click']) documentRef.addEventListener(type, onOpen, true);
    refresh();
    return () => {
        if (stopped) return;
        stopped = true; observer.disconnect();
        if (timer !== null) windowRef.clearTimeout(timer);
        for (const type of ['mousedown', 'touchend', 'click']) documentRef.removeEventListener(type, onOpen, true);
        for (const state of styledControls.values()) restoreStyledControl(state);
        for (const owner of styledSelectControls.values()) restoreStyledSelectControl(owner);
        for (const [container, { old, added, ungrouped, wasHidden, childClasses }] of styledMenus) {
            if (!container.querySelector('[data-cw-styled-model-group]')) continue;
            for (const node of old) if (container.contains(node)) container.append(node);
            for (const node of added) node.remove();
            for (const [row, existed] of childClasses) if (!existed) row.classList.remove('cw-picker-group-child');
            if (ungrouped) ungrouped.hidden = wasHidden;
        }
        for (const [select, state] of states) {
            const selected = select.selectedOptions?.[0];
            const nodes = [...select.children].flatMap(node => node.hasAttribute(OWN_GROUP) ? [...node.children] : [node]);
            nodes.sort((a, b) => (state.order.get(a) ?? Infinity) - (state.order.get(b) ?? Infinity));
            if (!sameNodes([...select.children], nodes)) select.replaceChildren(...nodes);
            if (selected && !selected.selected) select.selectedIndex = [...select.options].indexOf(selected);
        }
        states.clear(); styledMenus.clear(); styledControls.clear(); styledSelectControls.clear();
    };
}
