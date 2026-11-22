import { element, button } from './common.js';

/** Row activation excludes child controls and uses selection while in bulk mode. */
export function bindListRow(row, { label, activate, toggleSelected, isMulti, isSelected, isDisabled,
    canActivate = () => true, isCurrent = () => false, isConnecting = () => false, onError }) {
    const indicator = element('span', { class: 'cw-connection-state', 'aria-hidden': 'true' }, [element('i', { class: 'fa-solid fa-plug' })]);
    const icon = indicator.firstElementChild;
    let previousState = null;
    row.querySelector('.cw-row-actions')?.prepend(indicator);
    row.cwRefreshState = () => {
        const multi = isMulti(), available = canActivate(), current = isCurrent(), connecting = isConnecting();
        const disabled = isDisabled(), selected = multi && isSelected();
        const state = [multi, available, current, connecting, disabled, selected].map(Boolean).join(',');
        if (state === previousState) return;
        previousState = state;
        row.classList.toggle('cw-clickable-row', multi || available);
        row.classList.toggle('cw-current-row', current);
        row.tabIndex = multi || available ? 0 : -1;
        if (multi || available) row.setAttribute('role', multi ? 'checkbox' : 'button');
        else row.removeAttribute('role');
        row.setAttribute('aria-label', multi ? '勾选 ' + label : label + (current ? '，当前使用' : available ? '，点击切换' : ''));
        row.setAttribute('aria-disabled', String(disabled));
        if (multi) row.setAttribute('aria-checked', String(selected));
        else row.removeAttribute('aria-checked');
        row.setAttribute('aria-current', String(current));
        indicator.hidden = multi || (!available && !current);
        indicator.title = connecting ? '正在切换' : current ? '当前使用' : '点击切换';
        indicator.classList.toggle('cw-connection-current', current);
        icon.className = 'fa-solid ' + (connecting ? 'fa-spinner fa-spin' : current ? 'fa-circle-check' : 'fa-plug');
    };
    async function trigger(event) {
        if (isDisabled()) return;
        if (isMulti()) { toggleSelected(); return; }
        if (!canActivate()) return;
        try { await activate({ keyboard: event.type === 'keydown' }); } catch (error) { onError(error); }
    }
    row.addEventListener('click', event => {
        if (event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
        void trigger(event);
    });
    row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        void trigger(event);
    });
    row.cwRefreshState();
    return row;
}

export function continuousList(container, renderRow, { emptyText = '没有匹配的记录', batchSize = 60, keyOf = item => item?.id ?? item } = {}) {
    let items = [], keys = [], indices = new Map(), rows = [], limit = batchSize, disposed = false, frame = null, pendingPosition = null;
    const viewportTop = () => container.getBoundingClientRect().top + container.clientTop;
    const makeRow = index => {
        const node = renderRow(items[index]);
        rows.push({ node, key: keys[index], index });
        return node;
    };
    const append = () => {
        if (disposed || limit >= items.length) return;
        const next = Math.min(items.length, limit + batchSize);
        const fragment = document.createDocumentFragment();
        for (let index = limit; index < next; index++) fragment.append(makeRow(index));
        limit = next;
        container.append(fragment);
    };
    const onScroll = () => {
        if (container.scrollHeight - container.scrollTop - container.clientHeight < 150) append();
    };
    function capturePosition() {
        const top = container.scrollTop;
        if (top <= 0) return { top: 0 };
        const edge = viewportTop();
        // Rows are ordered vertically; locating the viewport needs only logarithmic layout reads.
        let start = 0, end = rows.length;
        while (start < end) {
            const middle = (start + end) >>> 1;
            if (rows[middle].node.getBoundingClientRect().bottom > edge) end = middle;
            else start = middle + 1;
        }
        const anchor = rows[start];
        return anchor ? { top, key: anchor.key, index: anchor.index, offset: anchor.node.getBoundingClientRect().top - edge, previousKeys: keys } : { top };
    }
    function anchorIndex(position) {
        if (!position.previousKeys) return -1;
        if (indices.has(position.key)) return indices.get(position.key);
        // If the visible record was deleted, keep browsing at its nearest surviving neighbour.
        for (let index = position.index + 1; index < position.previousKeys.length; index++) {
            if (indices.has(position.previousKeys[index])) return indices.get(position.previousKeys[index]);
        }
        for (let index = position.index - 1; index >= 0; index--) {
            if (indices.has(position.previousKeys[index])) return indices.get(position.previousKeys[index]);
        }
        return -1;
    }
    function restorePosition(position) {
        if (!position || disposed) return;
        const index = anchorIndex(position);
        const anchor = rows[index];
        if (!anchor) { container.scrollTop = position.top; return; }
        const desired = container.scrollTop + anchor.node.getBoundingClientRect().top - viewportTop() - position.offset;
        // Sorted inserts can move the anchor beyond the old loaded portion of the list.
        while (limit < items.length && desired > container.scrollHeight - container.clientHeight) append();
        container.scrollTop = Math.max(0, desired);
    }
    function schedulePosition(position) {
        pendingPosition = position;
        restorePosition(position);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = null;
            if (disposed) return;
            // Toolbar visibility, row wrapping and modal focus can settle after the immediate update.
            restorePosition(pendingPosition);
            pendingPosition = null;
            onScroll();
        });
    }
    const cancelRestore = () => { pendingPosition = null; };
    const onKeyDown = event => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) cancelRestore();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', cancelRestore, { passive: true });
    container.addEventListener('touchstart', cancelRestore, { passive: true });
    container.addEventListener('pointerdown', cancelRestore);
    container.addEventListener('keydown', onKeyDown);
    return {
        preservePosition(update) {
            if (disposed) return;
            const position = pendingPosition ?? capturePosition();
            update();
            schedulePosition(position);
        },
        setItems(next, { reset = false } = {}) {
            if (disposed) return;
            const position = reset ? { top: 0 } : pendingPosition ?? capturePosition();
            items = next;
            keys = items.map(keyOf);
            indices = new Map(keys.map((key, index) => [key, index]));
            limit = Math.min(items.length, reset ? batchSize : Math.max(limit, batchSize));
            const index = anchorIndex(position);
            if (index >= 0) limit = Math.min(items.length, Math.max(limit, index + batchSize));
            const fragment = document.createDocumentFragment();
            rows = [];
            for (let index = 0; index < limit; index++) fragment.append(makeRow(index));
            if (!items.length) {
                const empty = document.createElement('div'); empty.className = 'cw-empty'; empty.textContent = emptyText; fragment.append(empty);
            }
            container.replaceChildren(fragment);
            schedulePosition(position);
        },
        cleanup() {
            disposed = true; pendingPosition = null;
            if (frame !== null) cancelAnimationFrame(frame);
            container.removeEventListener('scroll', onScroll);
            container.removeEventListener('wheel', cancelRestore);
            container.removeEventListener('touchstart', cancelRestore);
            container.removeEventListener('pointerdown', cancelRestore);
            container.removeEventListener('keydown', onKeyDown);
        },
    };
}

export function createUsageControls({ kind, onChange }) {
    let oldestFirst = false;
    const profile = kind === 'profile';
    const labels = profile ? ['最近加载优先', '久未加载优先'] : ['最近使用优先', '久未使用优先'];
    const sortButton = button(labels[0], () => {
        oldestFirst = !oldestFirst;
        updateSort();
        onChange();
    }, 'cw-usage-sort');
    function updateSort() {
        const label = labels[Number(oldestFirst)];
        sortButton.title = label + '，点击切换排序';
        sortButton.setAttribute('aria-label', label);
        sortButton.setAttribute('aria-pressed', String(oldestFirst));
        sortButton.querySelector('i').className = 'fa-solid ' + (oldestFirst ? 'fa-arrow-up-wide-short' : 'fa-arrow-down-wide-short');
    }
    const timeFilter = element('select', {
        class: 'text_pole cw-usage-filter',
        'aria-label': profile ? '筛选方案闲置时间' : '筛选密钥闲置时间',
        onchange: onChange,
    }, [new Option('全部时间', '0'), new Option(profile ? '至少 30 天未加载' : '至少 30 天未使用', '30'),
        new Option(profile ? '至少 90 天未加载' : '至少 90 天未使用', '90')]);
    const filterRow = element('div', { class: 'cw-usage-filter-row', hidden: true }, [timeFilter]);
    updateSort();
    return {
        sortButton, timeFilter, filterRow,
        get oldestFirst() { return oldestFirst; },
        get days() { return Number(timeFilter.value); },
        setMulti(multi) {
            filterRow.hidden = !multi;
            if (!multi) timeFilter.value = '0';
        },
        setDisabled(busy) { sortButton.disabled = timeFilter.disabled = busy; },
    };
}
