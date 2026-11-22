

const DETAILS_SELECTOR = '#connection_profile_details_content';
const LABELS = {
    'Custom connection': '自定义连接',
    'API': 'API 来源',
    'Server URL': 'API 地址',
    'Settings Preset': '参数预设',
    'Model': '模型',
    'Proxy Preset': '反向代理预设',
    'Use System Prompt': '使用系统提示词',
    'System Prompt Name': '系统提示词预设',
    'Instruct Mode': '指令模式',
    'Instruct Template': '指令模板',
    'Context Template': '上下文模板',
    'Tokenizer': '分词器',
    'Custom Stopping Strings': '自定义停止字符串',
    'Start Reply With': '回复起始内容',
    'Reasoning Template': '推理模板',
    'Prompt Post-Processing': '提示词后处理',
    'Secret': 'API 密钥',
    'Regex Preset': '正则预设',
    'Omitted Settings:': '未随方案保存的设置',
};
const EXCLUDED_CONNECTION = 'Excluded: keep the current connection. Background requests require a complete override.';

function translateValue(key, value, profile) {
    if (['Custom Stopping Strings', 'Start Reply With'].includes(key) && value === '<Empty>') return '（空）';
    if (['Use System Prompt', 'Instruct Mode'].includes(key) && ['true', 'false'].includes(value)) return value === 'true' ? '启用' : '关闭';
    if (key !== 'Custom connection') return value;
    if (value === EXCLUDED_CONNECTION) return '未保存连接设置：沿用当前连接。后台请求需要提供完整的连接配置。';
    const snapshot = profile?.['custom-connection'];
    if (!snapshot?.settings) return value;
    const base = `${snapshot.provider?.label ?? 'Manual'} · ${snapshot.settings.custom_url} · ${snapshot.settings.custom_model}`;
    const localizedBase = `${snapshot.provider?.label ?? '手动配置'} · ${snapshot.settings.custom_url} · ${snapshot.settings.custom_model}`;
    if (value === base) return localizedBase;
    if (value === `${base} (extension unavailable)`) return `${localizedBase}（服务商扩展未启用）`;
    return value;
}

/** Translate the native details display without changing saved or user-entered values. */
export function localizeConnectionDetails(details, profile = null) {
    if (!details) return;
    if (!details.children.length && details.textContent.trim() === 'No profile selected') {
        details.textContent = '未选择连接方案';
        return;
    }
    for (const label of details.querySelectorAll('strong[data-i18n]')) {
        const key = label.getAttribute('data-i18n');
        if (!Object.hasOwn(LABELS, key)) continue;
        const text = [...label.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
        const translated = LABELS[key] + '：';
        if (text && text.nodeValue !== translated) text.nodeValue = translated;
        if (key === 'Omitted Settings:') {
            const omitted = label.nextElementSibling;
            if (!omitted || omitted.tagName !== 'SPAN' || omitted.children.length) continue;
            const value = omitted.textContent.split(', ').map(name => LABELS[name] ?? name).join('、');
            if (value !== omitted.textContent) omitted.textContent = value;
            continue;
        }
        for (let sibling = label.nextSibling; sibling; sibling = sibling.nextSibling) {
            if (sibling.nodeType !== 3 || !sibling.textContent.trim()) continue;
            const [, leading, value, trailing] = sibling.textContent.match(/^(\s*)([\s\S]*?)(\s*)$/);
            const localized = translateValue(key, value, profile);
            if (localized !== value) sibling.nodeValue = leading + localized + trailing;
        }
    }
}

/** Native details are rendered asynchronously and replaced whenever the selected profile changes. */
export function installConnectionDetailsLocalization({ root = document, getProfile = () => null } = {}) {
    const documentRef = root.ownerDocument ?? root;
    const localize = () => localizeConnectionDetails(root.matches?.(DETAILS_SELECTOR) ? root : root.querySelector(DETAILS_SELECTOR), getProfile());
    const observer = new documentRef.defaultView.MutationObserver(records => {
        if (records.some(record => {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            return target?.closest(DETAILS_SELECTOR) || [...record.addedNodes].some(node => node.nodeType === 1
                && (node.matches(DETAILS_SELECTOR) || node.querySelector(DETAILS_SELECTOR)));
        })) localize();
    });
    observer.observe(root.querySelector('#rm_api_block') ?? (root.nodeType === 9 ? root.body : root), { childList: true, subtree: true });
    localize();
    return () => observer.disconnect();
}

/** Translate only this extension's keys, preserving controls inserted into native headings. */
export function localizeOwnNodes(root, dictionary, translate) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
        for (const token of node.getAttribute('data-i18n').split(';')) {
            const attribute = token.match(/^\[([^\]]+)\](.+)$/);
            const key = attribute ? attribute[2] : token;
            if (!Object.hasOwn(dictionary, key)) continue;
            const value = translate(key, key);
            if (value === key) continue;
            if (attribute) { node.setAttribute(attribute[1], value); continue; }
            const text = [...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim());
            if (text) text.nodeValue = value;
            else if (!node.children.length) node.textContent = value;
        }
    }
}
