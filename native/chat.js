import { eventSource } from '../../../../../script.js';
import { event_types } from '../compat/events.js';
import { SECRET_KEYS, secret_state } from '../../../../secrets.js';
import { proxies } from '../../../../openai.js';
import { manageProxyPresets } from '../profiles/proxies.js';
import { button, element, showError } from '../ui/common.js';

const HIDDEN = 'cw-native-chat-hidden';
const ACCOUNT_KEY = SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT;

export function installNativeChatUi({ root = document, onError = showError } = {}) {
    const documentRef = root.ownerDocument ?? root;
    const windowRef = documentRef.defaultView;
    const page = root.querySelector('#openai_api');
    const hadPageClass = page?.classList.contains('cw-native-chat-page');
    page?.classList.add('cw-native-chat-page');
    let proxyUi = null, accountUi = null, regionUi = null, stopped = false, timer = null;

    function mountRegion(input) {
        const container = input.parentElement;
        const label = container?.querySelector('label[for="vertexai_region"]');
        if (!label) return null;
        const hadClass = container.classList.contains('cw-native-region-field');
        const heading = element('h4', { class: 'cw-native-region-heading' });
        label.before(heading);
        heading.append(label);
        container.classList.add('cw-native-region-field');
        return { input, cleanup() {
            heading.replaceWith(...heading.childNodes);
            container.classList.toggle('cw-native-region-field', hadClass);
        } };
    }

    function mountProxy(select) {
        const row = select.closest('.openai_logit_bias_preset_form');
        const drawer = select.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        const header = drawer?.querySelector(':scope > .inline-drawer-header');
        if (!row || !drawer || !content || !header) return null;
        const parent = row.parentElement, next = row.nextSibling;
        const hidden = [header, content, ...row.querySelectorAll('#save_proxy, #delete_proxy')].map(node => [node, node.classList.contains(HIDDEN)]);
        const hadRowClass = row.classList.contains('cw-native-proxy-row');
        const hadDrawerClass = drawer.classList.contains('cw-native-proxy');
        const label = element('label', { class: 'cw-native-proxy-heading', htmlFor: select.id, text: '反向代理' });
        const edit = button('编辑反向代理', async () => {
            try { await manageProxyPresets({ onChange: () => refresh(), onError }); }
            catch (error) { onError(error); }
        }, 'cw-native-chat-icon');
        edit.id = 'connection-workbench-edit-proxy';
        drawer.classList.add('cw-native-proxy');
        row.classList.add('cw-native-proxy-row');
        for (const [node] of hidden) node.classList.add(HIDDEN);
        drawer.insertBefore(label, content);
        drawer.insertBefore(row, content);
        row.append(edit);
        const labels = new Map();
        function refreshLabels() {
            const presets = new Map(proxies.map(preset => [preset.name, preset]));
            for (const option of select.options) {
                const preset = presets.get(option.value);
                if (!preset || String(preset.url ?? '').trim() || String(preset.password ?? '').trim()) continue;
                if (!labels.has(option)) labels.set(option, option.textContent);
                if (option.textContent !== '不使用反向代理') option.textContent = '不使用反向代理';
            }
        }
        refreshLabels();
        return { select, refresh: refreshLabels, cleanup() {
            edit.remove(); label.remove();
            if (next?.parentNode === parent) parent.insertBefore(row, next);
            else parent.append(row);
            row.classList.toggle('cw-native-proxy-row', hadRowClass);
            drawer.classList.toggle('cw-native-proxy', hadDrawerClass);
            for (const [node, wasHidden] of hidden) node.classList.toggle(HIDDEN, wasHidden);
            for (const [option, text] of labels) if (option.textContent === '不使用反向代理') option.textContent = text;
        } };
    }

    function mountAccount(input, validate) {
        const form = input.closest('#vertexai_full_config');
        const heading = form?.querySelector('h4');
        const row = input.parentElement;
        const status = form?.querySelector('#vertexai_service_account_status');
        const info = form?.querySelector('#vertexai_service_account_info');
        if (!form || !heading || !row || !status || !info) return null;
        const label = form.querySelector('label[for="vertexai_service_account_json"]');
        const help = form.querySelector('[data-for="vertexai_service_account_json"]');
        const buttonParent = validate.parentElement;
        const statusParent = status.parentElement, statusNext = status.nextSibling;
        const nodes = [input, validate, heading, row, status, info, label, help, buttonParent].filter(Boolean);
        const attributes = new Map(nodes.map(node => [node, [...node.attributes].map(attribute => [attribute.name, attribute.value])]));
        const infoContent = [...info.childNodes];
        const helpContent = help ? [...help.childNodes] : [];
        let disposed = false;
        validate.classList.add(HIDDEN);
        if ([...buttonParent.children].every(node => node === validate)) buttonParent.classList.add(HIDDEN);
        heading.classList.add('cw-service-account-heading');
        row.classList.add('cw-service-account-row');
        status.classList.add('cw-service-account-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        input.setAttribute('aria-label', 'Service Account JSON');
        input.readOnly = true;
        label?.classList.add(HIDDEN);
        if (help) {
            // Older hosts try to translate the attribute even after it is removed.
            if (help.hasAttribute('data-i18n')) help.setAttribute('data-i18n', '');
            help.classList.add('cw-service-account-help');
            help.textContent = '点击钥匙，在密钥库中验证并保存 Service Account JSON。';
        }
        heading.append(status);

        function render() {
            if (stopped || disposed) return;
            const account = secret_state[ACCOUNT_KEY]?.find(item => item.active);
            const state = account ? 'selected' : 'empty';
            const message = account ? '已选择保存的 JSON' : '未选择';
            if (status.dataset.cwAccountState !== state) status.dataset.cwAccountState = state;
            if (info.textContent !== message || info.children.length) info.textContent = message;
            if (status.style.display !== 'inline-flex') status.style.display = 'inline-flex';
            const placeholder = account ? `已选择：${account.label || '未命名账号'}` : '点击钥匙选择或新增 Service Account JSON';
            if (input.placeholder !== placeholder) input.placeholder = placeholder;
            if (input.title !== placeholder) input.title = placeholder;
        }

        input.addEventListener('input', render);
        render();
        return { input, validate, refresh: render, cleanup() {
            disposed = true;
            input.removeEventListener('input', render);
            if (statusNext?.parentNode === statusParent) statusParent.insertBefore(status, statusNext);
            else statusParent.append(status);
            info.replaceChildren(...infoContent);
            if (help) help.replaceChildren(...helpContent);
            for (const [node, saved] of attributes) {
                const original = new Map(saved);
                for (const { name } of [...node.attributes]) if (!original.has(name)) node.removeAttribute(name);
                for (const [name, value] of original) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
            }
        } };
    }

    function refresh() {
        if (stopped) return;
        const proxy = root.querySelector('#openai_proxy_preset');
        const account = root.querySelector('#vertexai_service_account_json');
        const validate = root.querySelector('#vertexai_validate_service_account');
        const region = root.querySelector('#vertexai_region');
        if (proxyUi?.select !== proxy) { proxyUi?.cleanup(); proxyUi = proxy ? mountProxy(proxy) : null; }
        if (accountUi?.input !== account || accountUi?.validate !== validate) {
            accountUi?.cleanup(); accountUi = account && validate ? mountAccount(account, validate) : null;
        }
        if (regionUi?.input !== region) { regionUi?.cleanup(); regionUi = region ? mountRegion(region) : null; }
        proxyUi?.refresh(); accountUi?.refresh();
    }
    const schedule = () => {
        if (stopped || timer !== null) return;
        timer = windowRef.setTimeout(() => { timer = null; refresh(); }, 0);
    };
    const observer = new windowRef.MutationObserver(records => {
        const selector = '#openai_proxy_preset, #vertexai_full_config, #vertexai_service_account_status, #vertexai_service_account_info, #vertexai_region';
        if (records.some(record => record.target.closest?.(selector) || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector))))) schedule();
    });
    observer.observe(root.querySelector('#rm_api_block') ?? (root.nodeType === 9 ? root.body : root), { childList: true, subtree: true, characterData: true });
    const events = [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED, event_types.SECRET_EDITED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CONNECTION_PROFILE_LOADED].filter(Boolean);
    for (const type of events) eventSource.on(type, schedule);
    refresh();
    return { refresh, cleanup() {
        if (stopped) return;
        stopped = true; observer.disconnect();
        if (timer !== null) windowRef.clearTimeout(timer);
        for (const type of events) eventSource.removeListener(type, schedule);
        proxyUi?.cleanup(); accountUi?.cleanup(); regionUi?.cleanup();
        page?.classList.toggle('cw-native-chat-page', Boolean(hadPageClass));
        proxyUi = null; accountUi = null; regionUi = null;
    } };
}
