import { proxies, selected_proxy } from '../../../../openai.js';
import { Popup } from '../../../../popup.js';
import { element, button, dialog, showError, themedPopupOptions } from '../ui/common.js';

/** Manage the native proxy presets without maintaining a second store or switching while browsing. */
export async function manageProxyPresets({ onChange = () => {}, onError = showError } = {}) {
    const root = element('div', { class: 'cw-dialog cw-editor cw-proxy-manager' });
    const controls = element('div', { class: 'cw-fields' });
    const status = element('span', { class: 'cw-field-note cw-note', role: 'status' });
    const saved = element('select', { class: 'text_pole', 'aria-label': '已保存代理预设' });
    const name = element('input', { class: 'text_pole', autocomplete: 'off', 'aria-label': '代理预设名称' });
    const url = element('input', { class: 'text_pole', autocomplete: 'off', placeholder: 'https://proxy.example.com/v1', 'aria-label': '代理地址' });
    const password = element('input', { class: 'text_pole', type: 'password', autocomplete: 'off', 'aria-label': '代理密码' });
    let editing = proxies.includes(selected_proxy) ? selected_proxy : proxies.find(entry => entry.name === selected_proxy?.name) ?? null;

    const label = entry => entry.name?.trim() ? entry.name : entry.url?.trim() || entry.password?.trim() ? '未命名代理（请先设置名称）' : '不使用反向代理';
    const titledField = (title, control, note = null) => element('label', { class: 'cw-field' }, [
        element('div', { class: 'cw-field-heading' }, [element('span', { text: title }), ...(note ? [note] : [])]), control,
    ]);
    function setStatus(message, important = false) {
        status.textContent = message;
        status.classList.toggle('cw-important-note', important);
    }
    function report(error) {
        setStatus(error?.message || '代理预设操作失败，请重试。', true);
        try { onError(error); } catch { /* Reporting must not break the dialog. */ }
    }
    function nativeControl(id) {
        const control = document.getElementById(id);
        if (!control) throw new Error('酒馆原生代理控件不可用，请刷新页面后重试。');
        return control;
    }
    function renderSelection() {
        saved.replaceChildren(new Option('新建代理预设', 'new'), ...proxies.map((entry, index) => new Option(label(entry), String(index))));
        const index = proxies.indexOf(editing);
        saved.value = index >= 0 ? String(index) : 'new';
        if (index < 0) editing = null;
        name.value = editing?.name ?? '';
        url.value = editing?.url ?? '';
        password.value = editing?.password ?? '';
        remove.disabled = !editing;
    }
    saved.addEventListener('change', () => {
        editing = saved.value === 'new' ? null : proxies[Number(saved.value)] ?? null;
        renderSelection();
        setStatus('');
    });

    const create = button('新建', () => {
        editing = null;
        renderSelection();
        setStatus('');
        name.focus();
    }, '', { textOnly: true });
    const save = button('保存', async () => {
        try {
            const values = { name: name.value.trim(), url: url.value.trim(), password: password.value };
            if (!values.name) throw new Error('请填写代理预设名称。');
            if (values.password && !values.url) throw new Error('请填写代理地址后再设置代理密码。');
            if (values.url) {
                let parsed;
                try { parsed = new URL(values.url); } catch { throw new Error('请填写有效的 HTTP(S) 代理地址。'); }
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
                    throw new Error('请使用不含账号和密码的 HTTP(S) 代理地址，密码填写在代理密码中。');
                }
            }
            const nativeName = nativeControl('openai_reverse_proxy_name');
            const nativeUrl = nativeControl('openai_reverse_proxy');
            const nativePassword = nativeControl('openai_proxy_access_key');
            const nativeSave = nativeControl('save_proxy');
            // The native save handler owns persistence and synchronizes the active connection.
            nativeName.value = values.name;
            nativeUrl.value = values.url;
            nativePassword.value = values.password;
            nativeSave.click();
            await Promise.resolve();
            const stored = proxies.find(entry => entry.name === values.name);
            if (!stored || stored.url !== values.url || stored.password !== values.password) {
                throw new Error('代理预设未能保存，请重试。');
            }
            editing = stored;
            renderSelection();
            await onChange(stored.name);
            setStatus('已保存。');
        } catch (error) { report(error); }
    }, '', { textOnly: true });
    const remove = button('删除', async () => {
        try {
            const target = editing;
            if (!target || !proxies.includes(target)) throw new Error('请选择一个已保存的代理预设。');
            const promptName = String(label(target)).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
            if (!await Popup.show.confirm('删除代理预设', `删除「${promptName}」？原生代理选择也会随之更新。`, themedPopupOptions())) return;
            if (!proxies.includes(target)) throw new Error('此代理预设已不存在，请重新选择。');
            const nativeName = nativeControl('openai_reverse_proxy_name');
            const nativeDelete = nativeControl('delete_proxy');
            nativeName.value = target.name;
            nativeDelete.click();
            await Promise.resolve();
            if (proxies.includes(target)) throw new Error('代理预设未能删除，请重试。');
            editing = null;
            renderSelection();
            await onChange(null);
            setStatus('已删除。');
        } catch (error) { report(error); }
    }, '', { textOnly: true });
    root.addEventListener('cw-action-settled', () => { remove.disabled = !editing; });
    root.append(element('div', { class: 'cw-field-heading' }, [
        element('h3', { class: 'cw-field-title', text: '管理代理预设' }),
        element('span', { class: 'cw-field-note cw-note cw-important-note', text: '保存代理预设会同步当前连接。' }),
    ]), controls, element('div', { class: 'cw-footer' }, [create, save, remove]));
    controls.append(titledField('已保存代理预设', saved, status),
        titledField('预设名称', name, element('span', { class: 'cw-field-note cw-note', text: '改名后保存为新预设。' })),
        titledField('代理地址', url), titledField('代理密码', password));
    renderSelection();
    if (!['openai_reverse_proxy_name', 'openai_reverse_proxy', 'openai_proxy_access_key', 'save_proxy', 'delete_proxy'].every(id => document.getElementById(id))) {
        setStatus('酒馆原生代理控件不可用，请刷新页面后重试。', true);
    }
    await dialog(root);
}
