import { groupModelEntries } from './grouping.js';
import { syncPickerTheme } from '../ui/select.js';

let nextId = 0;
const WINDOW_SIZE = 80;
const OVERSCAN = 20;

/** Add model suggestions to an editable ID without introducing another input or select. */
export function installModelPicker(input, { groupButtonStyle = 'icon' } = {}) {
    const documentRef = input.ownerDocument;
    const windowRef = documentRef.defaultView;
    const id = `cw-model-picker-${++nextId}`;
    const attributes = ['role', 'aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-activedescendant'];
    const previous = attributes.map(name => [name, input.getAttribute(name)]);
    const create = (tag, className) => {
        const node = documentRef.createElement(tag);
        node.className = className;
        return node;
    };
    const wrapper = create('div', 'cw-picker cw-model-combobox');
    const pickerRow = create('div', 'cw-model-picker-row');
    const toggle = create('button', 'cw-model-toggle');
    toggle.type = 'button';
    toggle.hidden = true;
    toggle.title = '选择模型';
    toggle.setAttribute('aria-label', '选择模型');
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', `${id}-results`);
    const groupState = create('button', groupButtonStyle === 'toolbar'
        ? 'menu_button cw-icon-button cw-model-group-state' : 'cw-picker-group-state cw-model-group-state');
    groupState.type = 'button';
    groupState.hidden = true;
    groupState.setAttribute('aria-controls', `${id}-results`);
    const groupStateIcon = create('i', 'fa-solid fa-compress');
    groupStateIcon.setAttribute('aria-hidden', 'true');
    groupState.append(groupStateIcon);
    input.replaceWith(pickerRow);
    pickerRow.append(wrapper, groupState);
    wrapper.append(input, toggle);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', `${id}-results`);
    const panel = create('div', 'cw-picker-panel cw-model-picker-panel');
    panel.hidden = true;
    panel.dataset.cwUi = '';
    const list = create('div', 'cw-picker-results');
    list.id = `${id}-results`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '模型选项');
    panel.append(list);
    wrapper.append(panel);

    let entries = [], foundEntries = [], matches = [], rows = new Map(), headings = [], highlighted = -1, stopped = false, choosing = false;
    let currentQuery = '', filteredValue = null, activeGroupKey = null;
    let themeDirty = true;
    let rowHeight = 30, headingHeight = 32, visibleRows = [], rowForMatch = [], rowOffsets = [0], renderedStart = -1, renderedEnd = -1;
    let scrollFrame = null;
    const counts = new Map();
    const collapsed = new Set();
    const groupKeys = new Set();
    const listeners = [];
    const listen = (target, type, callback, options) => {
        target.addEventListener(type, callback, options);
        listeners.push(() => target.removeEventListener(type, callback, options));
    };
    function close() {
        panel.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        syncGroupState();
    }
    function syncGroupState() {
        const searching = !panel.hidden && Boolean(currentQuery.trim());
        const expand = !searching && [...groupKeys].some(key => collapsed.has(key));
        groupState.hidden = !groupKeys.size;
        groupState.disabled = input.disabled || searching;
        groupState.title = expand ? '全部展开' : '全部收起';
        groupState.setAttribute('aria-label', groupState.title);
        groupStateIcon.className = `fa-solid ${expand ? 'fa-expand' : 'fa-compress'}`;
        pickerRow.classList.toggle('has-group-controls', !groupState.hidden);
    }
    function position() {
        if (panel.hidden) return;
        const rect = wrapper.getBoundingClientRect();
        const viewport = windowRef.visualViewport;
        const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
        const height = viewport?.height ?? windowRef.innerHeight, width = viewport?.width ?? windowRef.innerWidth;
        const below = top + height - rect.bottom - 8, above = rect.top - top - 8;
        const useAbove = below < 240 && above > below;
        panel.style.width = `${Math.min(rect.width, width - 16)}px`;
        panel.style.maxHeight = `${Math.max(0, Math.min(320, useAbove ? above : below))}px`;
        panel.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - rect.width - 8))}px`;
        panel.style.top = useAbove ? '' : `${rect.bottom + 4}px`;
        panel.style.bottom = useAbove ? `${windowRef.innerHeight - rect.top + 4}px` : '';
    }
    function highlight(index, scroll = false, trackGroup = true) {
        rows.get(highlighted)?.classList.remove('cw-picker-highlighted');
        highlighted = index;
        if (scroll && visibleRows.length > WINDOW_SIZE) {
            const top = rowOffsets[rowForMatch[index]];
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top + rowHeight - list.clientHeight);
            renderWindow();
        }
        const row = rows.get(index);
        if (row) {
            row.classList.add('cw-picker-highlighted');
            if (trackGroup) activeGroupKey = matches[index]?.group ? matches[index].groupKey : null;
            input.setAttribute('aria-activedescendant', row.id);
            if (scroll && visibleRows.length <= WINDOW_SIZE) row.scrollIntoView({ block: 'nearest' });
        } else input.removeAttribute('aria-activedescendant');
    }
    function renderWindow(force = false) {
        let first = 0;
        if (visibleRows.length > WINDOW_SIZE) {
            let end = visibleRows.length;
            while (first < end) {
                const middle = Math.floor((first + end) / 2);
                if (rowOffsets[middle + 1] <= list.scrollTop) first = middle + 1;
                else end = middle;
            }
        }
        const start = Math.max(0, first - OVERSCAN);
        const end = Math.min(visibleRows.length, start + Math.max(WINDOW_SIZE, Math.ceil(list.clientHeight / Math.min(rowHeight, headingHeight)) + OVERSCAN * 2));
        if (!force && start === renderedStart && end === renderedEnd) return;
        renderedStart = start; renderedEnd = end;
        rows.clear();
        for (const heading of headings) heading.node = null;
        const fragment = documentRef.createDocumentFragment();
        const spacer = height => {
            const node = create('div', 'cw-picker-spacer');
            node.style.height = `${height}px`;
            node.setAttribute('role', 'presentation');
            node.setAttribute('aria-hidden', 'true');
            return node;
        };
        if (start) fragment.append(spacer(rowOffsets[start]));
        for (let index = start; index < end; index++) {
            const item = visibleRows[index];
            if (item.headingIndex !== undefined) {
                const descriptor = headings[item.headingIndex];
                const heading = create('button', 'cw-picker-group cw-picker-group-toggle');
                heading.type = 'button';
                heading.dataset.groupIndex = String(item.headingIndex);
                heading.setAttribute('aria-expanded', String(descriptor.expanded));
                heading.disabled = Boolean(currentQuery.trim());
                heading.setAttribute('aria-label', heading.disabled ? `${descriptor.group}（${descriptor.count} 个匹配模型）`
                    : `${descriptor.expanded ? '收起' : '展开'}${descriptor.group}（${descriptor.count} 个模型）`);
                const arrow = create('span', 'cw-picker-group-arrow');
                arrow.append(create('i', 'fa-solid fa-angle-right'));
                arrow.setAttribute('aria-hidden', 'true');
                const label = create('span', 'cw-picker-group-label'); label.textContent = descriptor.group;
                const badge = create('span', 'cw-picker-group-count'); badge.textContent = String(descriptor.count);
                heading.append(arrow, label, badge);
                descriptor.node = heading;
                fragment.append(heading);
            } else {
                const entry = matches[item.matchIndex];
                const row = create('div', 'cw-picker-option' + (entry.group ? ' cw-picker-group-child' : '')
                    + (item.matchIndex === highlighted ? ' cw-picker-highlighted' : ''));
                row.style.height = `${rowHeight}px`;
                row.id = `${id}-option-${item.matchIndex}`;
                row.dataset.matchIndex = String(item.matchIndex);
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', String(entry.id === input.value));
                row.setAttribute('aria-posinset', String(item.matchIndex + 1));
                row.setAttribute('aria-setsize', String(matches.length));
                row.textContent = entry.label === entry.id ? entry.id : `${entry.label} · ${entry.id}`;
                row.title = row.textContent;
                rows.set(item.matchIndex, row);
                fragment.append(row);
            }
        }
        if (end < visibleRows.length) fragment.append(spacer(rowOffsets[visibleRows.length] - rowOffsets[end]));
        if (!visibleRows.length) {
            const empty = create('div', 'cw-picker-empty');
            empty.textContent = '没有匹配的模型，可继续手动填写';
            fragment.append(empty);
        }
        list.replaceChildren(fragment);
        const active = rows.get(highlighted);
        if (active) input.setAttribute('aria-activedescendant', active.id);
        else input.removeAttribute('aria-activedescendant');
    }
    function focusHeading(index) {
        const heading = headings[index];
        if (!heading) return;
        if (!heading.node) {
            list.scrollTop = rowOffsets[heading.rowIndex];
            renderWindow();
        }
        heading.node?.focus({ preventScroll: true });
    }
    function filter(query, { preserveScroll = false, preferredId = null } = {}) {
        currentQuery = query;
        filteredValue = input.value;
        const previousScroll = list.scrollTop;
        const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        foundEntries.length = 0;
        matches.length = 0;
        counts.clear();
        for (const entry of entries) {
            if (!terms.every(term => entry.searchable.includes(term))) continue;
            foundEntries.push(entry);
            counts.set(entry.groupKey, (counts.get(entry.groupKey) ?? 0) + 1);
        }
        const searching = Boolean(terms.length);
        visibleRows.length = 0; rowForMatch.length = 0; rowOffsets.length = 1; rowOffsets[0] = 0;
        headings.length = 0;
        let group = null;
        for (const entry of foundEntries) {
            if (entry.group && entry.groupKey !== group) {
                const expanded = searching || !collapsed.has(entry.groupKey);
                visibleRows.push({ headingIndex: headings.length });
                rowOffsets.push(rowOffsets[rowOffsets.length - 1] + headingHeight);
                headings.push({ key: entry.groupKey, group: entry.group, expanded, count: counts.get(entry.groupKey),
                    rowIndex: visibleRows.length - 1, node: null });
            }
            group = entry.groupKey;
            if (!entry.group || searching || !collapsed.has(entry.groupKey)) {
                const matchIndex = matches.length;
                matches.push(entry);
                rowForMatch[matchIndex] = visibleRows.length;
                visibleRows.push({ matchIndex });
                rowOffsets.push(rowOffsets[rowOffsets.length - 1] + rowHeight);
            }
        }
        list.scrollTop = preserveScroll ? previousScroll : 0;
        const preferred = preferredId ? matches.findIndex(entry => entry.id === preferredId) : -1;
        const selected = matches.findIndex(entry => entry.id === input.value);
        highlighted = preferred >= 0 ? preferred : selected >= 0 ? selected : matches.length ? 0 : -1;
        renderWindow(true);
        highlight(highlighted, !preserveScroll && visibleRows.length > WINDOW_SIZE, !preserveScroll);
        syncGroupState();
    }
    function foldGroup(key, force, focus = false) {
        if (key == null || currentQuery.trim()) return;
        const shouldCollapse = force ?? !collapsed.has(key);
        if (shouldCollapse) collapsed.add(key); else collapsed.delete(key);
        activeGroupKey = key;
        filter(currentQuery, { preserveScroll: true, preferredId: matches[highlighted]?.id });
        if (focus) focusHeading(headings.findIndex(heading => heading.key === key));
    }
    function open(query = '') {
        if (stopped || !entries.length || input.disabled) return;
        // Keep the panel in the owning dialog's top layer, outside its scrolling content.
        const owner = input.closest('dialog') ?? wrapper;
        if (panel.parentElement !== owner) { owner.append(panel); themeDirty = true; }
        const opening = panel.hidden;
        if (!opening && !themeDirty && query === currentQuery && filteredValue === input.value) return;
        if (themeDirty) {
            const style = windowRef.getComputedStyle(input);
            panel.style.fontFamily = style.fontFamily;
            panel.style.fontSize = style.fontSize;
            const inputHeight = input.getBoundingClientRect().height || 30;
            panel.style.setProperty('--cw-picker-row-height', `${inputHeight}px`);
            panel.style.setProperty('--cw-picker-option-padding', style.padding);
            panel.classList.toggle('cw-model-picker-styled', Boolean(documentRef.querySelector('#openai_api select[data-st-select-styler-processed]')));
            syncPickerTheme(panel, input);
            const probe = create('div', 'cw-picker-option');
            panel.append(probe);
            try {
                const optionStyle = windowRef.getComputedStyle(probe);
                const lineHeight = parseFloat(optionStyle.lineHeight) || (parseFloat(optionStyle.fontSize) || 15) * 1.2;
                rowHeight = parseFloat(optionStyle.height) || lineHeight + (parseFloat(optionStyle.paddingTop) || 0)
                    + (parseFloat(optionStyle.paddingBottom) || 0) + (parseFloat(optionStyle.borderTopWidth) || 0) + (parseFloat(optionStyle.borderBottomWidth) || 0);
                rowHeight = Math.max(rowHeight, parseFloat(optionStyle.minHeight) || 0);
                headingHeight = inputHeight + 2;
            } finally { probe.remove(); }
            themeDirty = false;
        }
        panel.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-expanded', 'true');
        if (opening) position();
        filter(query);
    }
    function choose(index) {
        const entry = matches[index];
        if (!entry || input.disabled || stopped) return;
        choosing = true;
        try {
            input.value = entry.id;
            input.focus({ preventScroll: true });
            input.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
            input.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
        } finally { choosing = false; close(); }
    }
    listen(input, 'input', () => { if (!choosing) open(input.value); });
    listen(input, 'click', () => open());
    listen(input, 'focus', () => { if (!choosing) open(); });
    listen(input, 'keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!entries.length) return;
            event.preventDefault();
            if (panel.hidden) { open(); if (event.key === 'ArrowUp') highlight(matches.length - 1, true); }
            else highlight(matches.length ? Math.max(0, Math.min(matches.length - 1, highlighted + (event.key === 'ArrowDown' ? 1 : -1))) : -1, true);
            if (!matches.length && headings.length) focusHeading(event.key === 'ArrowUp' ? headings.length - 1 : 0);
        } else if (event.key === 'Enter' && !panel.hidden && highlighted >= 0) {
            event.preventDefault(); event.stopPropagation(); choose(highlighted);
        } else if (event.key === 'Escape' && !panel.hidden) {
            event.preventDefault(); event.stopPropagation(); close();
        } else if (event.altKey && !panel.hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && activeGroupKey != null) {
            event.preventDefault(); event.stopPropagation(); foldGroup(activeGroupKey, event.key === 'ArrowLeft', true);
        } else if (event.key === 'Tab') close();
    });
    listen(toggle, 'mousedown', event => event.preventDefault());
    listen(toggle, 'click', () => {
        const wasOpen = !panel.hidden;
        input.focus({ preventScroll: true });
        if (wasOpen) close(); else open();
    });
    listen(groupState, 'mousedown', event => event.preventDefault());
    listen(groupState, 'click', event => {
        event.preventDefault(); event.stopPropagation();
        if (stopped || input.disabled || groupState.disabled || !groupKeys.size) return;
        if (panel.hidden) open();
        const expand = [...groupKeys].some(key => collapsed.has(key));
        for (const key of groupKeys) { if (expand) collapsed.delete(key); else collapsed.add(key); }
        filter('', { preserveScroll: true, preferredId: matches[highlighted]?.id });
    });
    listen(groupState, 'keydown', event => {
        if (event.key !== 'Escape' || panel.hidden) return;
        event.preventDefault(); event.stopPropagation(); close();
        choosing = true;
        try { input.focus({ preventScroll: true }); } finally { choosing = false; }
    });
    // Preserve input focus and keep the API drawer open while choosing suggestions.
    listen(panel, 'mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    listen(panel, 'touchstart', event => event.stopPropagation(), { passive: true });
    listen(list, 'click', event => {
        const heading = event.target.closest('[data-group-index]');
        if (heading && list.contains(heading)) {
            event.preventDefault(); event.stopPropagation();
            foldGroup(headings[Number(heading.dataset.groupIndex)]?.key, undefined, documentRef.activeElement === heading);
            return;
        }
        const row = event.target.closest('[data-match-index]');
        if (row && list.contains(row)) choose(Number(row.dataset.matchIndex));
    });
    listen(list, 'keydown', event => {
        const heading = event.target.closest('[data-group-index]');
        if (!heading || !list.contains(heading) || event.isComposing || event.keyCode === 229) return;
        if (['Enter', ' ', 'Spacebar', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const force = event.key === 'ArrowLeft' ? true : event.key === 'ArrowRight' ? false : undefined;
            foldGroup(headings[Number(heading.dataset.groupIndex)]?.key, force, true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation();
            const index = Number(heading.dataset.groupIndex) + (event.key === 'ArrowDown' ? 1 : -1);
            focusHeading(Math.max(0, Math.min(headings.length - 1, index)));
        } else if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); close();
            choosing = true;
            try { input.focus({ preventScroll: true }); } finally { choosing = false; }
        }
    });
    const outside = event => { if (!pickerRow.contains(event.target) && !panel.contains(event.target)) close(); };
    listen(documentRef, 'pointerdown', outside, true);
    listen(documentRef, 'focusin', outside);
    listen(list, 'scroll', () => {
        if (scrollFrame !== null || panel.hidden) return;
        scrollFrame = windowRef.requestAnimationFrame(() => {
            scrollFrame = null;
            if (!stopped && !panel.hidden) renderWindow();
        });
    });
    listen(windowRef, 'resize', () => {
        themeDirty = true;
        if (!panel.hidden) { open(currentQuery); position(); }
    });
    listen(windowRef, 'scroll', event => { if (!panel.contains(event.target)) position(); }, true);
    if (windowRef.visualViewport) {
        listen(windowRef.visualViewport, 'resize', position);
        listen(windowRef.visualViewport, 'scroll', position);
    }
    let themeTimer = null;
    const themeObserver = windowRef.MutationObserver ? new windowRef.MutationObserver(() => {
        themeDirty = true;
        if (input.disabled) { close(); return; }
        if (stopped || panel.hidden) return;
        if (themeTimer !== null) windowRef.clearTimeout(themeTimer);
        themeTimer = windowRef.setTimeout(() => {
            themeTimer = null;
            if (!stopped && !panel.hidden) open(currentQuery);
        }, 150);
    }) : null;
    if (themeObserver) {
        themeObserver.observe(input, { attributes: true, attributeFilter: ['style', 'class', 'disabled'] });
        themeObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        if (documentRef.body) themeObserver.observe(documentRef.body, { attributes: true, attributeFilter: ['style', 'class'] });
        if (documentRef.head) themeObserver.observe(documentRef.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
    }
    function clear() {
        if (stopped) return;
        entries = []; foundEntries.length = 0; matches.length = 0; rows.clear(); headings.length = 0; highlighted = -1; currentQuery = ''; filteredValue = null; activeGroupKey = null;
        visibleRows = []; rowForMatch = []; rowOffsets = [0]; renderedStart = -1; renderedEnd = -1;
        groupKeys.clear();
        close();
        list.replaceChildren();
        toggle.hidden = true;
        wrapper.classList.remove('has-options');
    }
    return {
        wrapper, row: pickerRow, groupState, panel, open, clear,
        setItems(items, { open: show = false } = {}) {
            if (stopped) return;
            clear();
            entries = groupModelEntries(items).map(entry => ({ ...entry, label: entry.label ?? entry.id,
                searchable: `${entry.id} ${entry.label ?? entry.id} ${entry.group}`.toLocaleLowerCase() }));
            for (const entry of entries) if (entry.group) groupKeys.add(entry.groupKey);
            toggle.hidden = !entries.length;
            wrapper.classList.toggle('has-options', Boolean(entries.length));
            syncGroupState();
            if (show) open();
        },
        cleanup() {
            if (stopped) return;
            clear(); stopped = true;
            themeObserver?.disconnect();
            if (themeTimer !== null) windowRef.clearTimeout(themeTimer);
            if (scrollFrame !== null) windowRef.cancelAnimationFrame(scrollFrame);
            collapsed.clear();
            for (const remove of listeners) remove();
            panel.remove();
            pickerRow.replaceWith(input);
            for (const [name, value] of previous) {
                if (value === null) input.removeAttribute(name);
                else input.setAttribute(name, value);
            }
        },
    };
}
