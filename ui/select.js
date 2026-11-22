

const DEFAULT_SELECTORS = [
    '#connection_profiles',
    '#custom_credential_select',
    '#openai_api select[id^="model_"][id$="_select"]',
];
const WINDOW_SIZE = 80;
const OVERSCAN = 20;
let nextId = 0;
const installedPickers = new WeakMap();
const openedPickers = new WeakMap();
const CONTROL_APPEARANCE = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-indent',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'box-shadow', 'text-shadow'];

function colorChannels(value) {
    const match = value?.match(/^rgba?\(([^)]+)\)$/);
    return match ? match[1].split(/[,\s/]+/).filter(Boolean).map(Number) : null;
}

function colorLuminance(value) {
    const channels = colorChannels(value);
    if (!channels) return null;
    return channels.slice(0, 3).reduce((sum, channel, index) => {
        const normalized = channel / 255;
        return sum + (normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
    }, 0);
}

function readableSurface(color, background, fallback, minimumAlpha = .88) {
    let channels = colorChannels(background);
    if (!channels || channels[3] === 0) channels = colorChannels(fallback);
    if (!channels) return fallback;
    const foreground = colorLuminance(color);
    const luminance = colorLuminance(`rgb(${channels.slice(0, 3).join(',')})`);
    if (foreground !== null && (Math.max(foreground, luminance) + .05) / (Math.min(foreground, luminance) + .05) < 4.5) {
        channels = foreground < .18 ? [255, 255, 255] : [24, 24, 24];
    }
    return `rgba(${channels.slice(0, 3).join(',')},${Math.max(channels[3] ?? 1, minimumAlpha)})`;
}

function readableText(color, background) {
    const foreground = colorLuminance(color), luminance = colorLuminance(background);
    if (foreground === null || luminance === null || (Math.max(foreground, luminance) + .05) / (Math.min(foreground, luminance) + .05) >= 4.5) return color;
    return luminance > .18 ? 'rgb(0,0,0)' : 'rgb(255,255,255)';
}

export function syncPickerTheme(panel, control, { trigger, search } = {}) {
    const documentRef = control.ownerDocument;
    const windowRef = documentRef.defaultView;
    if (!documentRef.documentElement) return;
    const drawer = control.closest('.drawer-content') ?? documentRef.querySelector('.drawer-content');
    const sampleRoot = control.parentElement ?? drawer ?? documentRef.body;
    const probes = [];
    const probe = (tag, className, type) => {
        const node = documentRef.createElement(tag);
        node.className = className;
        if (type) node.type = type;
        node.dataset.cwUi = '';
        node.style.cssText = 'position:absolute!important;left:-9999px!important;top:-9999px!important;visibility:hidden!important;pointer-events:none!important;';
        probes.push(node);
        sampleRoot.append(node);
        return node;
    };
    try {
        const controlStyle = windowRef.getComputedStyle(control);
        const drawerStyle = windowRef.getComputedStyle(drawer ?? documentRef.body);
        const inputProbe = probe('input', 'text_pole', 'text');
        const buttonProbe = probe('div', 'menu_button');
        const colorProbe = probe('span', '');
        const inputStyle = windowRef.getComputedStyle(inputProbe);
        const buttonStyle = windowRef.getComputedStyle(buttonProbe);
        const resolvedColors = new Map();
        const resolve = value => {
            if (!value || !windowRef.CSS.supports('color', value)) return '';
            if (resolvedColors.has(value)) return resolvedColors.get(value);
            colorProbe.style.setProperty('color', value, 'important');
            const color = windowRef.getComputedStyle(colorProbe).color;
            resolvedColors.set(value, color);
            return color;
        };
        const variable = name => resolve(controlStyle.getPropertyValue(name).trim());
        const foreground = variable('--gr-panel-text') || drawerStyle.color || controlStyle.color;
        const tint = variable('--SmartThemeBlurTintColor') || drawerStyle.backgroundColor;
        const background = readableSurface(foreground, variable('--gr-panel-bg') || tint, drawerStyle.backgroundColor);
        const inputColor = inputStyle.color || foreground;
        const selectColor = controlStyle.color || foreground;
        const hoverBackground = variable('--gr-hover-bg') || variable('--SmartThemeQuoteColor') || buttonStyle.backgroundColor || background;
        const selectedBackground = variable('--gr-selected-bg') || hoverBackground;
        const hoverColor = readableText(variable('--gr-primary-accent') || foreground, hoverBackground);
        const selectedColor = readableText(variable('--gr-primary-accent') || foreground, selectedBackground);
        const variables = {
            '--cw-picker-panel-fg': foreground,
            '--cw-picker-panel-bg': background,
            '--cw-picker-panel-border': variable('--gr-panel-border') || controlStyle.borderColor || drawerStyle.borderColor,
            '--cw-picker-input-fg': inputColor,
            '--cw-picker-input-bg': inputStyle.backgroundColor || background,
            '--cw-picker-control-fg': selectColor,
            '--cw-picker-control-bg': controlStyle.backgroundColor || background,
            '--cw-picker-hover-fg': hoverColor,
            '--cw-picker-hover-bg': readableSurface(hoverColor, hoverBackground, background, 1),
            '--cw-picker-selected-fg': selectedColor,
            '--cw-picker-selected-bg': readableSurface(selectedColor, selectedBackground, background, 1),
        };
        // Computed styles are live; finish reading before applying the copies.
        const appearances = {
            control: Object.fromEntries(CONTROL_APPEARANCE.map(property => [property, controlStyle.getPropertyValue(property)])),
            input: Object.fromEntries(CONTROL_APPEARANCE.map(property => [property, inputStyle.getPropertyValue(property)])),
        };
        const inputHeight = search ? inputProbe.getBoundingClientRect().height : 0;
        const arrowStyle = Object.fromEntries(['backgroundImage', 'backgroundSize', 'backgroundPosition', 'borderTopWidth', 'borderRightWidth',
            'borderBottomWidth', 'borderLeftWidth', 'paddingRight'].map(property => [property, controlStyle[property]]));
        const backdrop = [...documentRef.querySelectorAll('.drawer-content')].map(node => windowRef.getComputedStyle(node)).find(style => style.backgroundImage !== 'none');
        const backdropStyle = Object.fromEntries(['background-image', 'background-size', 'background-position', 'background-repeat']
            .map(property => [property, backdrop?.getPropertyValue(property)]));
        for (const target of [panel, trigger, search].filter(Boolean)) {
            for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
        }
        panel.style.setProperty('color', foreground, 'important');
        panel.style.setProperty('background-color', background, 'important');
        panel.style.setProperty('border-color', variables['--cw-picker-panel-border'], 'important');
        panel.style.setProperty('background-clip', 'border-box', 'important');
        for (const [target, kind] of [[trigger, 'control'], [search, 'input']]) {
            if (!target) continue;
            target.style.setProperty('color', variables[`--cw-picker-${kind}-fg`], 'important');
            target.style.setProperty('background-color', variables[`--cw-picker-${kind}-bg`], 'important');
            target.style.setProperty('background-image', 'none', 'important');
            target.style.setProperty('background-clip', 'border-box', 'important');
            for (const [property, value] of Object.entries(appearances[kind])) target.style.setProperty(property, value, 'important');
        }
        if (search) {
            if (inputHeight > 0) search.style.setProperty('height', `${inputHeight}px`, 'important');
            else search.style.removeProperty('height');
        }
        if (trigger) {
            const imageUrl = arrowStyle.backgroundImage.match(/^url\((?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^)]*))\)$/)?.slice(1).find(value => value !== undefined)?.trim();
            const fixedSvgArrow = imageUrl && (/^data:image\/svg\+xml[;,]/i.test(imageUrl) || /\.svg(?:[?#].*)?$/i.test(imageUrl))
                && /^\d+(?:\.\d+)?px\s+\d+(?:\.\d+)?px$/.test(arrowStyle.backgroundSize);
            const customArrow = imageUrl && (control.hasAttribute('data-st-select-styler-processed') || fixedSvgArrow);
            trigger.style.setProperty('--cw-picker-arrow-image', customArrow ? arrowStyle.backgroundImage : 'url("/img/down-arrow.svg")');
            trigger.style.setProperty('--cw-picker-arrow-size', customArrow ? arrowStyle.backgroundSize : '8px 5px');
            trigger.style.setProperty('--cw-picker-arrow-position', customArrow ? arrowStyle.backgroundPosition : 'right 6px center');
            trigger.style.setProperty('--cw-picker-arrow-inset', [arrowStyle.borderTopWidth, arrowStyle.borderRightWidth, arrowStyle.borderBottomWidth, arrowStyle.borderLeftWidth].join(' '));
            const arrowWidth = customArrow ? parseFloat(arrowStyle.backgroundSize) || 8 : 8;
            const caption = trigger.querySelector('.cw-picker-caption');
            if (caption) caption.style.paddingInlineEnd = `${Math.max(0, arrowWidth + 6 - (parseFloat(arrowStyle.paddingRight) || 0))}px`;
        }
        panel.style.setProperty('background-image', backdropStyle['background-image'] || 'none', 'important');
        for (const property of ['background-size', 'background-position', 'background-repeat']) {
            if (backdrop) panel.style.setProperty(property, backdropStyle[property], 'important');
            else panel.style.removeProperty(property);
        }
    } finally {
        probes.forEach(node => node.remove());
    }
}

function hasOtherPicker(select) {
    return select.classList.contains('select2-hidden-accessible')
        || select.hasAttribute('data-select2-id')
        || select.nextElementSibling?.classList.contains('select2-container')
        || select.hasAttribute('data-st-select-styler-processed');
}

function selectLabel(select) {
    const ariaLabel = select.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const filter = select.ownerDocument.defaultView.NodeFilter;
    const labels = Array.from(select.labels ?? []).map(item => {
        const walker = select.ownerDocument.createTreeWalker(item, filter.SHOW_ELEMENT | filter.SHOW_TEXT, {
            acceptNode: node => node.nodeType === 3 ? filter.FILTER_ACCEPT
                : node.tagName === 'SELECT' || node.classList.contains('cw-picker') ? filter.FILTER_REJECT : filter.FILTER_SKIP,
        });
        let text = '';
        for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.textContent;
        return text.trim();
    }).filter(Boolean);
    return labels.join(' ') || select.title || '选择选项';
}

function select2Containers(select) {
    const containers = new Set();
    const rendered = select.id ? select.ownerDocument.getElementById(`select2-${select.id}-container`) : null;
    const labelled = rendered?.closest('.select2-container');
    if (labelled) return [labelled];
    for (const direction of ['nextElementSibling']) {
        let node = select[direction];
        for (let index = 0; node && index < 3; index++, node = node[direction]) {
            if (node.tagName === 'SELECT') break;
            if (node.classList.contains('select2-container')) containers.add(node);
            if (!node.classList.contains('cw-picker') && !node.classList.contains('select2-container')) break;
        }
    }
    return [...containers];
}

/** Enhance single-select controls while retaining their options and native events. */
export function installSearchableSelects({ root = document, selectors = DEFAULT_SELECTORS, autoGroup = false, replaceExisting = false, onError = console.error } = {}) {
    const documentRef = root.ownerDocument ?? root;
    const windowRef = documentRef.defaultView;
    const selector = Array.isArray(selectors) ? selectors.join(',') : selectors;
    const pickers = new Map();
    let opened = null;
    let scanTimer = null;
    let positionFrame = null;
    let destroyed = false;

    function report(error) {
        try { onError?.(error); } catch { /* An error reporter cannot interrupt the UI. */ }
    }

    function createPicker(select) {
        const superseded = new Map();
        let existingHeight = 0;
        const concealExisting = () => {
            if (!replaceExisting) return;
            for (const container of select2Containers(select)) {
                const selection = container.querySelector('.select2-selection') ?? container;
                const height = selection.getBoundingClientRect().height || parseFloat(windowRef.getComputedStyle(selection).height);
                if (height > 1) existingHeight = height;
                if (!superseded.has(container)) superseded.set(container, container.classList.contains('cw-picker-superseded'));
                if (!container.classList.contains('cw-picker-superseded')) container.classList.add('cw-picker-superseded');
            }
        };
        const previousRect = select.getBoundingClientRect();
        const previousContainer = replaceExisting ? select2Containers(select)[0] : null;
        const initialRect = previousContainer?.getBoundingClientRect().width > 1 ? previousContainer.getBoundingClientRect() : previousRect;
        const savedTabIndex = select.getAttribute('tabindex');
        const savedAriaHidden = select.getAttribute('aria-hidden');
        select.classList.add('cw-picker-native');
        const initialStyle = windowRef.getComputedStyle(select);
        concealExisting();
        const parentStyle = windowRef.getComputedStyle(select.parentElement);
        const parentWidth = select.parentElement.clientWidth - (parseFloat(parentStyle.paddingLeft) || 0) - (parseFloat(parentStyle.paddingRight) || 0);
        const id = `cw-picker-${++nextId}`;
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'cw-picker';
        wrapper.style.margin = initialStyle.margin;
        if (select.classList.contains('flex1')) wrapper.classList.add('flex1');
        else wrapper.style.width = select.style.width || (!initialRect.width || Math.abs(initialRect.width - parentWidth) < 2 ? '100%' : `${initialRect.width}px`);
        wrapper.dataset.cwUi = '';
        const trigger = documentRef.createElement('button');
        trigger.type = 'button';
        trigger.className = 'cw-picker-trigger text_pole';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', `${id}-results`);
        const caption = documentRef.createElement('span');
        caption.className = 'cw-picker-caption';
        trigger.append(caption);
        wrapper.append(trigger);

        const panel = documentRef.createElement('div');
        panel.className = 'cw-picker-panel';
        panel.dataset.cwUi = '';
        panel.hidden = true;
        const search = documentRef.createElement('input');
        search.className = 'cw-picker-search text_pole';
        search.type = 'search';
        search.placeholder = '搜索名称…';
        search.autocomplete = 'off';
        search.setAttribute('aria-label', '搜索下拉选项');
        search.setAttribute('role', 'combobox');
        search.setAttribute('aria-autocomplete', 'list');
        search.setAttribute('aria-expanded', 'false');
        search.setAttribute('aria-controls', `${id}-results`);
        const searchRow = documentRef.createElement('div');
        searchRow.className = 'cw-picker-search-row';
        const groupState = documentRef.createElement('button');
        groupState.type = 'button';
        groupState.className = 'cw-picker-group-state';
        groupState.hidden = true;
        groupState.setAttribute('aria-controls', `${id}-results`);
        const groupStateIcon = documentRef.createElement('i');
        groupStateIcon.className = 'fa-solid fa-compress';
        groupStateIcon.setAttribute('aria-hidden', 'true');
        groupState.append(groupStateIcon);
        searchRow.append(search, groupState);
        const list = documentRef.createElement('div');
        list.className = 'cw-picker-results';
        list.id = `${id}-results`;
        list.setAttribute('role', 'listbox');
        const footer = documentRef.createElement('div');
        footer.className = 'cw-picker-footer';
        const status = documentRef.createElement('span');
        status.className = 'cw-picker-status';
        status.setAttribute('aria-live', 'polite');
        footer.append(status);
        panel.append(searchRow, list, footer);
        const popover = typeof panel.showPopover === 'function';
        if (popover) panel.setAttribute('popover', 'manual');
        (select.closest('dialog') ?? documentRef.body).append(panel);
        select.after(wrapper);
        select.setAttribute('tabindex', '-1');
        select.setAttribute('aria-hidden', 'true');

        let entries = [];
        let entriesDirty = true;
        let entryGroupKeys = new Set();
        let matches = [];
        let filteredCount = 0;
        const collapsedGroups = new Set();
        let lastGroupKey = null;
        let rows = [];
        let rowForMatch = [];
        let renderedRows = null;
        let renderedStart = -1;
        let renderedEnd = -1;
        let rowHeight = existingHeight || (initialRect.height > 1 ? initialRect.height : 0) || parseFloat(initialStyle.height) || (parseFloat(initialStyle.fontSize) || 15) * 1.5;
        let metricsSignature = '';
        let themeSignature = '';
        let highlighted = -1;
        let lastValue = null;
        let lastIndex = null;
        let lastDisabled = null;
        let lastHidden = null;
        let lastConnected = null;
        let nativeHidden = false;
        let stopped = false;
        let updateTimer = null;
        let scrollFrame = null;
        const listeners = [];
        const listen = (target, event, callback, options) => {
            target.addEventListener(event, callback, options);
            listeners.push(() => target.removeEventListener(event, callback, options));
        };

        function syncMetrics() {
            const style = windowRef.getComputedStyle(select);
            // The hidden native select retains its natural height, font and padding.
            const measuredHeight = select.getBoundingClientRect().height;
            const height = existingHeight || measuredHeight || parseFloat(style.height) || rowHeight;
            const signature = [height, Boolean(measuredHeight), style.margin, ...CONTROL_APPEARANCE.map(property => style.getPropertyValue(property)),
                style.color, style.backgroundColor, style.backgroundImage, style.backgroundSize, style.backgroundPosition, select.hasAttribute('data-st-select-styler-processed')].join('|');
            if (signature === metricsSignature) return;
            metricsSignature = signature;
            const metrics = { margin: style.margin, fontFamily: style.fontFamily, fontSize: style.fontSize, padding: style.padding };
            const previousHeight = rowHeight;
            rowHeight = height;
            groupState.style.height = `${height}px`;
            groupState.style.width = `${height}px`;
            trigger.style.setProperty('height', `${height}px`, 'important');
            // Most API sources start in hidden panels; sample their theme when they become visible.
            if (measuredHeight > 0) syncTheme({ style });
            wrapper.style.margin = metrics.margin;
            panel.style.fontFamily = metrics.fontFamily;
            panel.style.fontSize = metrics.fontSize;
            panel.style.setProperty('--cw-picker-row-height', `${rowHeight}px`);
            panel.style.setProperty('--cw-picker-option-padding', metrics.padding);
            if (!panel.hidden) {
                list.scrollTop = previousHeight ? list.scrollTop / previousHeight * rowHeight : 0;
                render();
                position();
            }
        }

        function syncTheme({ style = windowRef.getComputedStyle(select) } = {}) {
            const ancestors = [];
            for (let node = select.parentElement; node; node = node.parentElement) {
                ancestors.push(node.id, node.getAttribute('class'), node.getAttribute('style'));
            }
            const signature = [style.color, style.backgroundColor, style.borderColor, style.backgroundImage, style.backgroundSize, style.backgroundPosition,
                ...CONTROL_APPEARANCE.map(property => style.getPropertyValue(property)),
                ...['--gr-panel-text', '--gr-panel-bg', '--gr-panel-border', '--gr-hover-bg', '--gr-selected-bg', '--gr-primary-accent',
                    '--SmartThemeBlurTintColor', '--SmartThemeQuoteColor'].map(property => style.getPropertyValue(property)), ...ancestors].join('|');
            if (signature === themeSignature) return;
            themeSignature = signature;
            syncPickerTheme(panel, select, { trigger, search });
        }

        function position() {
            if (panel.hidden) return;
            const rect = trigger.getBoundingClientRect();
            const viewportHeight = windowRef.visualViewport?.height ?? windowRef.innerHeight;
            const viewportWidth = windowRef.visualViewport?.width ?? windowRef.innerWidth;
            const viewportTop = windowRef.visualViewport?.offsetTop ?? 0;
            const viewportLeft = windowRef.visualViewport?.offsetLeft ?? 0;
            const width = Math.max(0, Math.min(rect.width, viewportWidth - 16));
            const below = viewportTop + viewportHeight - rect.bottom - 8;
            const above = rect.top - viewportTop - 8;
            const useAbove = below < 240 && above > below;
            const height = Math.max(64, Math.min(430, useAbove ? above : below));
            panel.style.width = `${width}px`;
            panel.style.maxHeight = `${height}px`;
            const left = Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + viewportWidth - width - 8));
            const top = Math.max(viewportTop + 8, useAbove ? rect.top - panel.getBoundingClientRect().height - 4 : rect.bottom + 4);
            const owner = popover ? null : select.closest('dialog');
            const ownerRect = owner?.getBoundingClientRect();
            panel.style.position = owner ? 'absolute' : 'fixed';
            panel.style.left = `${owner ? left - ownerRect.left - owner.clientLeft + owner.scrollLeft : left}px`;
            panel.style.top = `${owner ? top - ownerRect.top - owner.clientTop + owner.scrollTop : top}px`;
            panel.style.bottom = '';
        }

        function close({ focus = false } = {}) {
            if (panel.hidden) return;
            if (popover && panel.matches(':popover-open')) panel.hidePopover();
            panel.hidden = true;
            updateGroupState();
            trigger.setAttribute('aria-expanded', 'false');
            search.setAttribute('aria-expanded', 'false');
            search.removeAttribute('aria-activedescendant');
            if (opened === picker) opened = null;
            if (openedPickers.get(documentRef) === picker) openedPickers.delete(documentRef);
            if (focus && select.isConnected) trigger.focus();
        }

        function sync({ metrics = true } = {}) {
            if (stopped) return;
            if (!root.contains(select) || !select.matches(selector) || !replaceExisting && hasOtherPicker(select) || select.multiple) {
                destroy();
                return;
            }
            if (metrics) {
                concealExisting();
                syncMetrics();
                nativeHidden = windowRef.getComputedStyle(select).display === 'none';
            }
            if (lastValue !== select.value || lastIndex !== select.selectedIndex || lastDisabled !== select.disabled) {
                const option = select.selectedOptions[0];
                caption.textContent = option?.label || '请选择';
                trigger.title = caption.textContent;
                const label = selectLabel(select);
                trigger.setAttribute('aria-label', label);
                trigger.setAttribute('aria-description', caption.textContent);
                trigger.disabled = select.disabled;
                lastValue = select.value;
                lastIndex = select.selectedIndex;
                lastDisabled = select.disabled;
                if (!panel.hidden) {
                    const current = matches.findIndex(entry => entry.option.selected);
                    if (current >= 0) setHighlight(current);
                    else render();
                }
            }
            wrapper.hidden = !select.isConnected || select.hidden || nativeHidden;
            lastHidden = select.hidden;
            lastConnected = select.isConnected;
            if (trigger.disabled || wrapper.hidden || !panel.hidden && !trigger.getClientRects().length) close();
        }

        function rebuild() {
            if (stopped) return;
            const groupKeys = new Map(), labels = new Map();
            for (const group of select.querySelectorAll('optgroup')) {
                const ordinal = labels.get(group.label) ?? 0;
                labels.set(group.label, ordinal + 1);
                const stableId = group.dataset.cwConnectionGroup || group.dataset.cwModelGroup || group.id;
                groupKeys.set(group, stableId ? `id:${stableId}` : `label:${group.label}:${ordinal}`);
            }
            entries = Array.from(select.options, (option, index) => {
                const group = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
                const label = option.label;
                return { option, index, label, group: group?.label ?? '', groupNode: group, groupKey: groupKeys.get(group) ?? null,
                    disabled: option.disabled || Boolean(group?.disabled), hidden: option.hidden || Boolean(group?.hidden), searchable: `${label} ${option.value} ${group?.label ?? ''}`.toLocaleLowerCase() };
            }).filter(entry => !entry.hidden);
            if (autoGroup && !/^model_.*_select$/.test(select.id)) entries = groupSelectEntries(entries).map(entry => ({ ...entry,
                searchable: `${entry.label} ${entry.option.value} ${entry.group}`.toLocaleLowerCase() }));
            entryGroupKeys = new Set(entries.filter(entry => entry.group).map(entry => entry.groupKey));
            entriesDirty = false;
        }

        function setHighlight(index, scrollOnly = false) {
            highlighted = index;
            const rowIndex = rowForMatch[index];
            if (rowIndex !== undefined) {
                const top = rowIndex * rowHeight;
                if (top < list.scrollTop) list.scrollTop = top;
                else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top + rowHeight - list.clientHeight);
            }
            render(scrollOnly);
        }

        function render(scrollOnly = false) {
            const start = Math.max(0, Math.floor(list.scrollTop / rowHeight) - OVERSCAN);
            const end = Math.min(rows.length, start + Math.max(WINDOW_SIZE, Math.ceil(list.clientHeight / rowHeight) + OVERSCAN * 2));
            if (scrollOnly && renderedRows === rows && start === renderedStart && end === renderedEnd) return;
            renderedRows = rows; renderedStart = start; renderedEnd = end;
            const fragment = documentRef.createDocumentFragment();
            const spacer = height => {
                const node = documentRef.createElement('div');
                node.className = 'cw-picker-spacer';
                node.style.height = `${height}px`;
                node.setAttribute('role', 'presentation');
                node.setAttribute('aria-hidden', 'true');
                return node;
            };
            if (start) fragment.append(spacer(start * rowHeight));
            for (let index = start; index < end; index++) {
                const item = rows[index];
                if (item.group !== undefined) {
                    const heading = documentRef.createElement('button');
                    heading.type = 'button';
                    heading.className = 'cw-picker-group cw-picker-group-toggle';
                    heading.dataset.groupKey = item.groupKey;
                    heading.setAttribute('aria-expanded', String(item.expanded));
                    heading.setAttribute('aria-label', `${item.expanded ? '收起' : '展开'} ${item.group} (${item.count})`);
                    heading.title = search.value.trim() ? '搜索时自动展开，清空搜索后恢复折叠状态' : heading.getAttribute('aria-label');
                    heading.disabled = select.disabled || Boolean(search.value.trim());
                    const arrow = documentRef.createElement('span');
                    arrow.className = 'cw-picker-group-arrow';
                    const arrowIcon = documentRef.createElement('i');
                    arrowIcon.className = 'fa-solid fa-angle-right';
                    arrow.append(arrowIcon);
                    arrow.setAttribute('aria-hidden', 'true');
                    const label = documentRef.createElement('span');
                    label.className = 'cw-picker-group-label';
                    label.textContent = item.group;
                    const count = documentRef.createElement('span');
                    count.className = 'cw-picker-group-count';
                    count.textContent = String(item.count);
                    count.setAttribute('aria-hidden', 'true');
                    heading.append(arrow, label, count);
                    fragment.append(heading);
                    continue;
                }
                const entry = matches[item.matchIndex];
                const row = documentRef.createElement('div');
                row.className = 'cw-picker-option' + (entry.group ? ' cw-picker-group-child' : '') + (item.matchIndex === highlighted ? ' cw-picker-highlighted' : '');
                row.id = `${id}-option-${entry.index}`;
                row.dataset.matchIndex = String(item.matchIndex);
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', String(entry.option.selected));
                row.setAttribute('aria-disabled', String(entry.disabled));
                row.setAttribute('aria-posinset', String(item.matchIndex + 1));
                row.setAttribute('aria-setsize', String(matches.length));
                row.textContent = entry.label || '（空）';
                row.title = entry.label;
                fragment.append(row);
            }
            if (end < rows.length) fragment.append(spacer((rows.length - end) * rowHeight));
            if (!rows.length) {
                const empty = documentRef.createElement('div');
                empty.className = 'cw-picker-empty';
                empty.textContent = '没有匹配的选项';
                fragment.append(empty);
            }
            list.replaceChildren(fragment);
            updateGroupState();
            status.textContent = matches.length === filteredCount ? `${filteredCount} 项` : `${filteredCount} 项 · 显示 ${matches.length} 项`;
            const activeRow = list.querySelector(`[data-match-index="${highlighted}"]`);
            if (activeRow) search.setAttribute('aria-activedescendant', activeRow.id);
            else search.removeAttribute('aria-activedescendant');
        }

        function filter({ reset = true, preferredOption = null, focusedGroup = null } = {}) {
            if (entriesDirty) rebuild();
            const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
            const filtered = entries.filter(entry => terms.every(term => entry.searchable.includes(term)));
            filteredCount = filtered.length;
            const counts = new Map();
            for (const entry of filtered) if (entry.groupKey) counts.set(entry.groupKey, (counts.get(entry.groupKey) ?? 0) + 1);
            const searching = terms.length > 0;
            matches = [];
            rows = [];
            rowForMatch = [];
            let group = null;
            for (const entry of filtered) {
                const expanded = searching || !collapsedGroups.has(entry.groupKey);
                if (entry.group && entry.groupKey !== group) rows.push({ group: entry.group, groupKey: entry.groupKey,
                    expanded, count: counts.get(entry.groupKey) });
                group = entry.groupKey;
                if (entry.group && !expanded) continue;
                const matchIndex = matches.length;
                matches.push(entry);
                rowForMatch.push(rows.length);
                rows.push({ matchIndex });
            }
            highlighted = preferredOption ? matches.findIndex(entry => entry.option === preferredOption && !entry.disabled) : -1;
            if (highlighted < 0) highlighted = matches.findIndex(entry => !entry.disabled);
            list.scrollTop = reset ? 0 : Math.max(0, Math.min(list.scrollTop, rows.length * rowHeight - list.clientHeight));
            render();
            position();
            if (focusedGroup) [...list.querySelectorAll('[data-group-key]')].find(node => node.dataset.groupKey === focusedGroup)?.focus({ preventScroll: true });
        }

        function toggleGroup(key, { focusHeading = false, expanded } = {}) {
            if (!key || select.disabled || search.value.trim()) return;
            const preferredOption = matches[highlighted]?.option ?? null;
            lastGroupKey = key;
            const nextExpanded = expanded ?? collapsedGroups.has(key);
            if (nextExpanded) collapsedGroups.delete(key); else collapsedGroups.add(key);
            filter({ reset: false, preferredOption, focusedGroup: focusHeading ? key : null });
        }

        function updateGroupState() {
            const keys = entryGroupKeys;
            const allExpanded = ![...keys].some(key => collapsedGroups.has(key));
            const searching = !panel.hidden && Boolean(search.value.trim());
            groupState.hidden = !keys.size;
            groupState.disabled = select.disabled || searching;
            const title = allExpanded || searching ? '全部收起' : '全部展开';
            groupState.title = title;
            groupState.setAttribute('aria-label', title);
            groupState.setAttribute('aria-expanded', String(allExpanded || searching));
            groupStateIcon.className = `fa-solid ${allExpanded || searching ? 'fa-compress' : 'fa-expand'}`;
        }

        function toggleAllGroups() {
            if (groupState.disabled || stopped) return;
            const keys = entryGroupKeys;
            const expand = [...keys].some(key => collapsedGroups.has(key));
            const preferredOption = matches[highlighted]?.option ?? null;
            for (const key of keys) { if (expand) collapsedGroups.delete(key); else collapsedGroups.add(key); }
            lastGroupKey = null;
            filter({ reset: false, preferredOption });
        }

        function open() {
            sync();
            if (stopped || trigger.disabled || wrapper.hidden) return;
            openedPickers.get(documentRef)?.close();
            opened = picker;
            openedPickers.set(documentRef, picker);
            const panelOwner = select.closest('dialog') ?? documentRef.body;
            if (panel.parentElement !== panelOwner) panelOwner.append(panel);
            syncTheme();
            panel.hidden = false;
            if (popover) panel.showPopover();
            trigger.setAttribute('aria-expanded', 'true');
            search.setAttribute('aria-expanded', 'true');
            search.value = '';
            position();
            filter({ preferredOption: select.selectedOptions[0] });
            if (highlighted >= 0) setHighlight(highlighted, true);
            search.focus({ preventScroll: true });
        }

        function choose(index) {
            const entry = matches[index];
            if (!entry || entry.disabled || entry.hidden || select.disabled) return;
            // Options can be replaced by another extension while the picker is open.
            if (!entry.option.isConnected || entry.option.closest('select') !== select) { entriesDirty = true; filter(); return; }
            select.selectedIndex = entry.option.index;
            close({ focus: true });
            select.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
            lastValue = null;
            sync();
        }

        function move(direction) {
            let index = highlighted;
            if (index < 0) index = direction > 0 ? -1 : matches.length;
            do { index += direction; } while (index >= 0 && index < matches.length && matches[index].disabled);
            if (index < 0 || index >= matches.length) return;
            setHighlight(index);
        }

        listen(trigger, 'click', () => panel.hidden ? open() : close());
        // The portal is outside its owning drawer. Core listens on html and would
        // treat its pointer/touch presses as outside presses; keep their defaults.
        for (const type of ['mousedown', 'touchstart']) listen(panel, type, event => event.stopPropagation());
        // Mouse presses keep the search input focused; Tab can still reach each heading.
        listen(list, 'mousedown', event => {
            if (event.target.closest('[data-group-key], [data-match-index]')) event.preventDefault();
        });
        listen(trigger, 'keydown', event => {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
        });
        listen(select, 'focus', () => { if (!stopped) trigger.focus(); });
        listen(select, 'change', () => { lastValue = null; sync({ metrics: false }); });
        listen(search, 'input', filter);
        listen(groupState, 'mousedown', event => event.preventDefault());
        listen(groupState, 'click', event => { event.preventDefault(); event.stopPropagation(); if (panel.hidden) open(); toggleAllGroups(); });
        listen(groupState, 'keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ focus: true }); }
        });
        listen(panel, 'keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ focus: true }); }
            else if (event.target.closest?.('[data-group-key]') && ['Enter', ' '].includes(event.key) && !event.isComposing) {
                event.preventDefault(); event.stopPropagation();
                toggleGroup(event.target.closest('[data-group-key]').dataset.groupKey, { focusHeading: true });
            }
            else if (event.target === search && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                const key = event.key === 'ArrowRight' && lastGroupKey && collapsedGroups.has(lastGroupKey)
                    ? lastGroupKey : matches[highlighted]?.groupKey;
                if (key) { event.preventDefault(); toggleGroup(key, { expanded: event.key === 'ArrowRight' }); }
            }
            else if (event.target === search && event.key === 'ArrowDown') { event.preventDefault(); move(1); }
            else if (event.target === search && event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
            else if (event.target === search && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); choose(highlighted); }
        });
        listen(list, 'click', event => {
            const heading = event.target.closest('[data-group-key]');
            if (heading && list.contains(heading)) {
                event.preventDefault(); event.stopPropagation();
                toggleGroup(heading.dataset.groupKey, { focusHeading: documentRef.activeElement === heading });
                return;
            }
            const row = event.target.closest('[data-match-index]');
            if (row && list.contains(row)) choose(Number(row.dataset.matchIndex));
        });
        listen(list, 'scroll', () => {
            if (scrollFrame !== null) return;
            scrollFrame = windowRef.requestAnimationFrame(() => { scrollFrame = null; if (!stopped && !panel.hidden) render(true); });
        });

        let metricsDirty = false;
        const observer = new windowRef.MutationObserver(records => {
            if (records.some(record => record.target !== select || record.type === 'childList')) entriesDirty = true;
            if (records.some(record => record.type === 'attributes' && record.target === select)) metricsDirty = true;
            if (updateTimer !== null) return;
            updateTimer = windowRef.setTimeout(() => {
                updateTimer = null;
                try {
                    lastValue = null;
                    const metrics = metricsDirty;
                    metricsDirty = false;
                    sync({ metrics });
                    if (!panel.hidden && entriesDirty) filter({ preferredOption: select.selectedOptions[0] });
                } catch (error) { report(error); destroy(); }
            }, 0);
        });
        observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
        const resizeObserver = typeof windowRef.ResizeObserver === 'function' ? new windowRef.ResizeObserver(() => {
            if (stopped) return;
            try { sync(); } catch (error) { report(error); destroy(); }
        }) : null;
        resizeObserver?.observe(select);
        if (select.parentElement) resizeObserver?.observe(select.parentElement);

        function destroy() {
            if (stopped) return;
            stopped = true;
            close();
            observer.disconnect();
            resizeObserver?.disconnect();
            if (updateTimer !== null) windowRef.clearTimeout(updateTimer);
            if (scrollFrame !== null) windowRef.cancelAnimationFrame(scrollFrame);
            for (const remove of listeners) remove();
            wrapper.remove();
            panel.remove();
            for (const [container, wasHidden] of superseded) if (!wasHidden) container.classList.remove('cw-picker-superseded');
            select.classList.remove('cw-picker-native');
            if (select.getAttribute('tabindex') === '-1') {
                if (savedTabIndex === null) select.removeAttribute('tabindex');
                else select.setAttribute('tabindex', savedTabIndex);
            }
            if (select.getAttribute('aria-hidden') === 'true') {
                if (savedAriaHidden === null) select.removeAttribute('aria-hidden');
                else select.setAttribute('aria-hidden', savedAriaHidden);
            }
            pickers.delete(select);
            if (installedPickers.get(select) === picker) installedPickers.delete(select);
        }

        const picker = {
            sync,
            poll: () => {
                // Selection changes without a native event still reach the caption.
                // Option edits are observed separately, so unchanged indices do not need a value lookup.
                if (lastIndex !== select.selectedIndex || lastDisabled !== select.disabled
                    || !root.contains(select) || select.hidden !== lastHidden || select.isConnected !== lastConnected) sync({ metrics: select.hidden !== lastHidden });
            },
            syncTheme: () => { metricsSignature = ''; themeSignature = ''; syncMetrics(); },
            close, destroy, position, wrapper, panel,
        };
        pickers.set(select, picker);
        installedPickers.set(select, picker);
        sync();
        return picker;
    }

    function scan() {
        if (destroyed) return;
        for (const [select, picker] of [...pickers]) {
            if (!root.contains(select) || !select.matches(selector)) picker.destroy();
            else picker.sync();
        }
        const candidates = Array.from(root.querySelectorAll(selector));
        if (root.matches?.(selector)) candidates.unshift(root);
        for (const select of candidates) {
            if (select.tagName !== 'SELECT' || select.multiple || installedPickers.has(select) || select.classList.contains('cw-picker-native') || !replaceExisting && hasOtherPicker(select)) continue;
            try { createPicker(select); } catch (error) { report(error); pickers.get(select)?.destroy(); }
        }
    }

    const observer = new windowRef.MutationObserver(records => {
        if (destroyed || scanTimer !== null) return;
        const relevant = records.some(record => record.type === 'attributes' && record.target.tagName === 'SELECT'
            && (!pickers.has(record.target) || !record.target.matches(selector))
            || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1
                && !node.closest?.('[data-cw-ui]') && (node.tagName === 'SELECT' || node.classList.contains('select2-container') || node.querySelector?.('select'))));
        if (!relevant) return;
        scanTimer = windowRef.setTimeout(() => { scanTimer = null; try { scan(); } catch (error) { report(error); } }, 0);
    });
    let themeTimer = null;
    const themeObserver = new windowRef.MutationObserver(() => {
        if (themeTimer !== null) windowRef.clearTimeout(themeTimer);
        themeTimer = windowRef.setTimeout(() => {
            themeTimer = null;
            for (const picker of pickers.values()) {
                try { picker.syncTheme(); } catch (error) { report(error); }
            }
        }, 150);
    });
    themeObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    if (documentRef.body) themeObserver.observe(documentRef.body, { attributes: true, attributeFilter: ['style', 'class'] });
    if (documentRef.head) themeObserver.observe(documentRef.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
    const onOutside = event => {
        if (opened && !opened.wrapper.contains(event.target) && !opened.panel.contains(event.target)) opened.close();
    };
    const onFocus = event => {
        if (opened && !opened.wrapper.contains(event.target) && !opened.panel.contains(event.target)) opened.close();
    };
    const onPosition = event => {
        if (!opened || event?.type === 'scroll' && opened.panel.contains(event.target) || positionFrame !== null) return;
        positionFrame = windowRef.requestAnimationFrame(() => {
            positionFrame = null;
            opened?.position();
        });
    };
    documentRef.addEventListener('pointerdown', onOutside, true);
    documentRef.addEventListener('focusin', onFocus);
    documentRef.addEventListener('scroll', onPosition, true);
    windowRef.addEventListener('resize', onPosition);
    windowRef.visualViewport?.addEventListener('resize', onPosition);
    windowRef.visualViewport?.addEventListener('scroll', onPosition);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'id', 'multiple', 'style'] });
    const poll = windowRef.setInterval(() => {
        if (documentRef.hidden) return;
        for (const picker of pickers.values()) {
            try { picker.poll(); } catch (error) { report(error); picker.destroy(); }
        }
    }, 500);
    try { scan(); } catch (error) { report(error); }

    return () => {
        if (destroyed) return;
        destroyed = true;
        observer.disconnect();
        themeObserver.disconnect();
        if (themeTimer !== null) windowRef.clearTimeout(themeTimer);
        windowRef.clearInterval(poll);
        if (scanTimer !== null) windowRef.clearTimeout(scanTimer);
        if (positionFrame !== null) windowRef.cancelAnimationFrame(positionFrame);
        documentRef.removeEventListener('pointerdown', onOutside, true);
        documentRef.removeEventListener('focusin', onFocus);
        documentRef.removeEventListener('scroll', onPosition, true);
        windowRef.removeEventListener('resize', onPosition);
        windowRef.visualViewport?.removeEventListener('resize', onPosition);
        windowRef.visualViewport?.removeEventListener('scroll', onPosition);
        for (const picker of [...pickers.values()]) picker.destroy();
    };
}

/** Find repeated name prefixes without changing options, values or their order. */
export function groupSelectEntries(entries) {
    const candidates = entries.map(entry => {
        if (entry.group || !String(entry.option?.value ?? entry.value ?? '').trim()) return null;
        const text = String(entry.label ?? '').trim();
        const bracket = text.match(/^(?:\[([^\]\r\n]{1,64})\]|【([^】\r\n]{1,64})】|\(([^)\r\n]{1,64})\)|（([^）\r\n]{1,64})）)\s*(\S.*)$/);
        const separated = text.match(/^([^/:：|｜\r\n]{1,64})\s*[/:：|｜]\s*(\S.*)$/);
        const spaced = text.match(/^(.{1,64}?)\s+[-–—_]\s+(\S.*)$/);
        const named = text.match(/^([\p{L}\p{N}][\p{L}\p{N} .]{1,48})[-_]([\p{L}][\p{L}\p{N} ._-]*)$/u);
        const match = bracket || separated || spaced || named;
        const prefix = bracket ? (bracket[1] ?? bracket[2] ?? bracket[3] ?? bracket[4]) : match?.[1];
        const suffix = bracket ? bracket[5] : match?.[2];
        if (!prefix || !suffix || /^(?:https?|models?)$/i.test(prefix.trim())) return null;
        return { label: prefix.trim(), key: prefix.trim().toLocaleLowerCase() };
    });
    const members = new Map();
    entries.forEach((entry, index) => {
        const candidate = candidates[index];
        if (!candidate) return;
        if (!members.has(candidate.key)) members.set(candidate.key, new Set());
        members.get(candidate.key).add(String(entry.option?.value ?? entry.value ?? entry.label));
    });
    return entries.map((entry, index) => {
        const candidate = candidates[index];
        if (!candidate || members.get(candidate.key).size < 2) return entry;
        return { ...entry, group: candidate.label, groupKey: `prefix:${candidate.key}` };
    });
}
