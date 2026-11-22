import { Popup, POPUP_TYPE } from '../../../../popup.js';

const BUTTON_ICONS = {
    '新建空白连接': 'fa-plus',
    '管理方案': 'fa-folder-open', '保存为新方案': 'fa-file-circle-plus', '更新方案': 'fa-floppy-disk',
    '选择密钥': 'fa-key', '管理密钥': { icon: 'fa-key', badge: 'fa-gear' }, '自定义模型': 'fa-plus',
    '使用': 'fa-plug', '编辑': 'fa-pen', '修复': 'fa-wrench', '复制': 'fa-copy', '删除': 'fa-trash',
    '选择': 'fa-check', '改名': 'fa-pen-to-square', '移除': 'fa-trash', '保存方案': 'fa-floppy-disk',
    '上一页': 'fa-chevron-left', '下一页': 'fa-chevron-right', '新增密钥': 'fa-plus',
    '删除所选': 'fa-trash', '停止删除': 'fa-stop', '选择本页': 'fa-square-check',
    '全选搜索结果': 'fa-check-double', '清空选择': 'fa-xmark', '添加模型': 'fa-plus', '不使用密钥': 'fa-ban',
    '复制所选': 'fa-copy', '复制已存方案': 'fa-copy', '保存当前连接为方案': 'fa-file-circle-plus', '保存当前连接': 'fa-file-circle-plus', '新建连接方案': 'fa-file-circle-plus',
    '全部展开': 'fa-expand', '全部收起': 'fa-compress',
    '多选': 'fa-list-check',
    '新建连接组': 'fa-folder-plus', '归入连接组': 'fa-folder-tree',
    '添加模型方案': 'fa-plus', '管理连接组': 'fa-gear',
    '最近使用优先': 'fa-arrow-down-wide-short', '最近加载优先': 'fa-arrow-down-wide-short',
    '拉取模型': 'fa-arrows-rotate',
    '编辑反向代理': 'fa-pen',
    '识别重复密钥': 'fa-magnifying-glass', '停止识别': 'fa-stop', '合并重复密钥': 'fa-object-group', '停止合并': 'fa-stop',
    '按方案名重命名': 'fa-wand-magic-sparkles',
    '按方案名批量重命名': 'fa-wand-magic-sparkles',
};

export function element(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'class') node.className = value;
        else if (key in node && !key.startsWith('aria')) node[key] = value;
        else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
}

export function button(text, action, className = '', { textOnly = false, showLabel = false } = {}) {
    const icon = textOnly ? null : BUTTON_ICONS[text];
    const glyph = typeof icon === 'string' ? icon : icon?.icon;
    return element('button', { type: 'button', class: 'menu_button ' + className + (icon && !showLabel ? ' cw-icon-button' : ''), title: text, 'aria-label': text, ...(icon ? {} : { text }), onclick: async event => {
        const target = event.currentTarget;
        if (target.disabled) return;
        target.disabled = true;
        try { await action(); } finally { target.disabled = false; target.dispatchEvent(new CustomEvent('cw-action-settled', { bubbles: true })); }
    } }, icon ? [element('i', { class: 'fa-solid ' + glyph, 'aria-hidden': 'true' }), ...(icon.badge ? [element('i', { class: 'fa-solid cw-icon-badge ' + icon.badge, 'aria-hidden': 'true' })] : []), ...(showLabel ? [element('span', { text })] : [])] : []);
}

export function field(label, control, note = '') {
    return element('label', { class: 'cw-field' }, [element('span', { text: label }), control, ...(note ? [element('small', { class: 'cw-note', text: note })] : [])]);
}

const popupThemes = new WeakMap();
const themeControls = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="hidden"]), textarea, select, button, .menu_button';

function dialogSurface(color, background, fallback) {
    const channels = value => value?.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    let bg = channels(background);
    if (!bg || bg[3] === 0) bg = channels(fallback);
    if (!bg) return fallback;
    const fg = channels(color);
    const luma = values => .299 * values[0] + .587 * values[1] + .114 * values[2];
    if (fg && Math.abs(luma(bg) - luma(fg)) < 90) bg = luma(fg) < 128 ? [255, 255, 255] : [24, 24, 24];
    return `rgba(${bg.slice(0, 3).join(',')},${Math.max(bg[3] ?? 1, .88)})`;
}

function themedControls(root) {
    return [...root.querySelectorAll(themeControls)].filter(control => !control.closest('.cw-picker, .cw-picker-panel')
        && !control.matches('select.cw-picker-native, select.select2-hidden-accessible, .no-theme-sync'));
}

function controlSample(control) {
    const tag = control.tagName.toLowerCase();
    const buttonLike = tag === 'button' || control.classList.contains('menu_button');
    const className = buttonLike ? 'menu_button' + (control.classList.contains('active') ? ' active' : '') : 'text_pole';
    const type = tag === 'input' ? control.type : '';
    const disabled = Boolean(control.disabled);
    return { control, tag, sampleTag: buttonLike && tag !== 'button' ? 'div' : tag, className, type, disabled,
        key: [tag, className, type, disabled].join('|') };
}

function applyDialogTheme(contentEl, { skipBg = false, theme = null, controls = null } = {}) {
    if (!contentEl) return false;
    const documentRef = contentEl.ownerDocument;
    const windowRef = documentRef.defaultView;
    const drawer = contentEl.closest('.drawer-content') ?? documentRef.querySelector('.drawer-content');
    if (!drawer) return false;
    const probes = [], fragment = documentRef.createDocumentFragment();
    const descriptors = (controls ?? themedControls(contentEl)).map(controlSample);
    const sample = (tag, className = '', type = '', disabled = false) => {
        const node = documentRef.createElement(tag);
        node.className = className;
        if (type) node.type = type;
        node.disabled = disabled;
        node.dataset.cwUi = '';
        node.style.cssText = 'position:absolute!important;left:-9999px!important;top:-9999px!important;width:1px!important;height:1px!important;visibility:hidden!important;pointer-events:none!important;';
        probes.push(node);
        fragment.append(node);
        return node;
    };
    try {
        const fresh = !theme;
        let colorProbe;
        if (fresh) {
            const drawerStyle = windowRef.getComputedStyle(drawer);
            const tint = drawerStyle.getPropertyValue('--SmartThemeBlurTintColor').trim();
            colorProbe = sample('span');
            if (tint && windowRef.CSS.supports('color', tint)) colorProbe.style.setProperty('color', tint, 'important');
            theme = { color: drawerStyle.color, background: drawerStyle.backgroundColor, border: drawerStyle.borderColor, tint: Boolean(tint && windowRef.CSS.supports('color', tint)), samples: new Map() };
            let backdrop;
            for (const node of documentRef.querySelectorAll('.drawer-content')) {
                const style = node === drawer ? drawerStyle : windowRef.getComputedStyle(node);
                if (style.backgroundImage !== 'none') { backdrop = style; break; }
            }
            theme.backdrop = Object.fromEntries(['background-image', 'background-size', 'background-position', 'background-repeat'].map(property => [property, backdrop?.getPropertyValue(property) ?? '']));
        }
        const missing = new Map();
        for (const descriptor of descriptors) {
            if (!theme.samples.has(descriptor.key) && !missing.has(descriptor.key)) {
                missing.set(descriptor.key, sample(descriptor.sampleTag, descriptor.className, descriptor.type, descriptor.disabled));
            }
        }
        if (probes.length) drawer.append(fragment);
        if (fresh) theme.background = dialogSurface(theme.color, theme.tint ? windowRef.getComputedStyle(colorProbe).color : theme.background, theme.background);
        for (const [key, probe] of missing) {
            const style = windowRef.getComputedStyle(probe);
            theme.samples.set(key, { color: style.color, background: style.backgroundColor || theme.background });
        }
        const { color, background } = theme;
        if (fresh) {
            contentEl.style.setProperty('color', color, 'important');
            contentEl.style.setProperty('--cw-dialog-fg', color);
            contentEl.style.setProperty('--cw-dialog-bg', background);
            contentEl.style.setProperty('--cw-dialog-border', theme.border);
            if (!skipBg) {
                contentEl.style.setProperty('background-color', background, 'important');
                contentEl.style.setProperty('background-image', theme.backdrop['background-image'] || 'none', 'important');
                for (const property of ['background-size', 'background-position', 'background-repeat']) {
                    if (theme.backdrop[property]) contentEl.style.setProperty(property, theme.backdrop[property], 'important');
                    else contentEl.style.removeProperty(property);
                }
            }
            contentEl.style.setProperty('background-clip', 'border-box', 'important');
            for (const root of contentEl.querySelectorAll('.cw-dialog')) root.style.setProperty('color', color, 'important');
        }
        for (const { control, tag, key } of descriptors) {
            const style = theme.samples.get(key);
            control.style.setProperty('color', style.color, 'important');
            control.style.setProperty('background-color', style.background, 'important');
            control.style.setProperty('background-clip', 'border-box', 'important');
            if (tag !== 'select') control.style.setProperty('background-image', 'none', 'important');
        }
        contentEl.classList.add('cw-theme-synced');
        return theme;
    } catch (error) {
        console.warn('API 连接管理：弹窗主题同步失败', error);
        return false;
    } finally {
        for (const probe of probes) probe.remove();
    }
}

function installPopupTheme(popup) {
    if (popupThemes.has(popup)) return popupThemes.get(popup);
    const root = popup.dlg;
    if (!root.isConnected || !root.open) return () => {};
    const documentRef = root.ownerDocument;
    const windowRef = documentRef.defaultView;
    root.classList.add('cw-themed-popup');
    let timer = null, frame = null, stopped = false, theme = null, themeChanged = true;
    const dirtyControls = new Set();
    const sync = () => {
        if (stopped) return;
        theme = applyDialogTheme(root, { theme: themeChanged ? null : theme,
            controls: themeChanged || !theme ? null : [...dirtyControls].filter(control => root.contains(control)) }) || null;
        themeChanged = false;
        dirtyControls.clear();
    };
    const schedule = () => {
        if (stopped || timer !== null) return;
        timer = windowRef.setTimeout(() => { timer = null; sync(); }, 80);
    };
    const scheduleInitialSync = () => {
        if (stopped || frame !== null) return;
        frame = windowRef.requestAnimationFrame(() => { frame = null; sync(); });
    };
    const themeObserver = new windowRef.MutationObserver(() => { themeChanged = true; schedule(); });
    themeObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    if (documentRef.body) themeObserver.observe(documentRef.body, { attributes: true, attributeFilter: ['style', 'class'] });
    if (documentRef.head) themeObserver.observe(documentRef.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
    const controlsObserver = new windowRef.MutationObserver(records => {
        const collect = node => {
            if (node.nodeType !== 1 || node.closest('[data-cw-ui], .cw-picker, .cw-picker-panel')
                || node.matches('select.cw-picker-native, select.select2-hidden-accessible')) return;
            if (node.matches(themeControls) && !node.matches('select.cw-picker-native, select.select2-hidden-accessible, .no-theme-sync')) dirtyControls.add(node);
            if (node.childElementCount) for (const control of themedControls(node)) dirtyControls.add(control);
        };
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.target.matches(themeControls)) collect(record.target);
            } else for (const node of record.addedNodes) collect(node);
        }
        if (dirtyControls.size) schedule();
    });
    const dispose = () => {
        if (stopped) return;
        stopped = true;
        if (timer !== null) windowRef.clearTimeout(timer);
        if (frame !== null) windowRef.cancelAnimationFrame(frame);
        themeObserver.disconnect();
        controlsObserver.disconnect();
        dirtyControls.clear();
        root.removeEventListener('close', dispose);
        popupThemes.delete(popup);
    };
    popupThemes.set(popup, dispose);
    scheduleInitialSync();
    controlsObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
    root.addEventListener('close', dispose, { once: true });
    return dispose;
}

export function themedPopupOptions(options = {}) {
    const onOpen = options.onOpen;
    const themed = { ...options, onOpen: popup => {
        installPopupTheme(popup);
        return onOpen?.(popup);
    } };
    queueMicrotask(() => {
        for (const popup of Popup.util?.popups ?? []) {
            if (popup.onOpen === themed.onOpen) installPopupTheme(popup);
        }
    });
    return themed;
}

export async function showThemedPopup(popup) {
    const style = popup.dlg.style;
    const visibility = [style.getPropertyValue('visibility'), style.getPropertyPriority('visibility')];
    const restore = () => visibility[0] ? style.setProperty('visibility', ...visibility) : style.removeProperty('visibility');
    let dispose;
    style.setProperty('visibility', 'hidden', 'important');
    try {
        const result = popup.show();
        dispose = installPopupTheme(popup);
        restore();
        popup.setAutoFocus?.();
        return await result;
    } finally { restore(); dispose?.(); }
}

export function dialog(root, options = {}) {
    const editor = root.classList.contains('cw-editor');
    const popup = new Popup(root, POPUP_TYPE.TEXT, '', { wide: true, large: !editor, okButton: '关闭', ...options });
    popup.dlg.classList.add('cw-popup');
    if (editor) popup.dlg.classList.add('cw-editor-popup');
    const footer = root.querySelector('.cw-footer');
    if (footer) {
        for (const control of footer.children) control.classList.add('cw-popup-action');
        popup.buttonControls.prepend(...footer.children);
        footer.remove();
    }
    return showThemedPopup(popup);
}

export function installNativeSizing() {
    const style = document.documentElement.style;
    const names = ['--cw-icon-width', '--cw-control-height', '--cw-control-font-size'];
    const previous = names.map(name => [name, style.getPropertyValue(name)]);
    let disposed = false;
    let frame = null;
    const measure = () => {
        frame = null;
        if (disposed) return;
        const controls = [document.getElementById('update_connection_profile'), document.querySelector('#rm_api_block .manage-api-keys')];
        const native = controls.filter(Boolean).map(node => ({ node, rect: node.getBoundingClientRect() })).find(item => item.rect.height > 0);
        if (!native) return;
        const values = [native.rect.width + 'px', native.rect.height + 'px', getComputedStyle(native.node).fontSize];
        for (let index = 0; index < names.length; index++) {
            if (style.getPropertyValue(names[index]) !== values[index]) style.setProperty(names[index], values[index]);
        }
    };
    const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    const area = document.getElementById('rm_api_block');
    if (area) observer.observe(area);
    for (const control of [document.getElementById('update_connection_profile'), area?.querySelector('.manage-api-keys')]) if (control) observer.observe(control);
    const themeObserver = new MutationObserver(schedule);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener?.('loadingdone', schedule);
    schedule();
    return () => {
        disposed = true;
        observer.disconnect(); themeObserver.disconnect(); window.removeEventListener('resize', schedule);
        if (frame !== null) cancelAnimationFrame(frame);
        document.fonts?.removeEventListener?.('loadingdone', schedule);
        for (const [name, value] of previous) if (value) style.setProperty(name, value); else style.removeProperty(name);
    };
}

export function searchInput(placeholder, handler) {
    return element('input', { type: 'search', class: 'text_pole', placeholder, 'aria-label': placeholder, oninput: handler });
}

export function showError(error) {
    const original = error?.message ?? String(error);
    const messages = {
        'The key is not approved for this exact API root. Select it again.': '密钥绑定的 API 地址与当前地址不同，请重新选择密钥。',
        'The captured Custom key no longer exists. Choose a stored key.': '方案记住的旧密钥已删除，请在管理方案里重新选择。',
        'The profile key no longer exists. Choose a stored key.': '此方案保存的密钥已删除，请重新选择。',
        'The profile key is not approved for this API root.': '此方案的密钥地址绑定已失效，请编辑修复。',
        'Choose a stored key for this connection before connecting.': '请选一把已保存密钥；免密接口请选择“不使用密钥”。',
    };
    toastr.error(messages[original] ?? original, 'API 连接管理');
}
