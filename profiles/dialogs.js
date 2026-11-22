import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../popup.js';
import { element, showThemedPopup } from '../ui/common.js';

/** Confirm a frozen profile selection, defaulting to cleanup when unshared keys are available. */
export async function confirmProfileDeletion(targets, { removable = [], retained = [] } = {}) {
    if (!Array.isArray(targets) || !targets.length) throw new Error('请选择要删除的连接方案。');
    const root = element('div', { class: 'cw-dialog cw-delete-confirm' });
    const checkbox = element('input', {
        type: 'checkbox', checked: removable.length > 0, disabled: removable.length === 0,
        'aria-label': '同时删除未被其他方案引用的密钥',
    });
    const summary = element('span', { class: 'cw-delete-summary cw-note', role: 'status', 'aria-live': 'polite' });
    function updateSummary() {
        const deleteKeys = Boolean(checkbox.checked && removable.length);
        summary.textContent = deleteKeys
            ? `同时删除 ${removable.length} 把密钥，保留 ${retained.length} 把共用密钥。`
            : removable.length ? '已保存的密钥会保留。'
                : retained.length ? `${retained.length} 把密钥仍被其他方案引用，会保留。` : '没有可清理的存储密钥。';
        summary.classList.toggle('cw-important-note', deleteKeys);
    }
    checkbox.addEventListener('change', updateSummary);
    root.append(element('h3', { text: targets.length === 1 ? '删除连接方案' : '批量删除连接方案' }),
        element('p', { text: targets.length === 1 ? `删除「${targets[0].name ?? targets[0].id ?? ''}」？` : `删除勾选的 ${targets.length} 个方案？` }),
        element('label', { class: 'checkbox_label cw-delete-key-option' }, [
            checkbox, element('span', { text: '同时删除未被其他方案引用的密钥' }),
        ]), summary);
    updateSummary();
    const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消', wide: false });
    popup.dlg.classList.add('cw-delete-popup');
    const result = await showThemedPopup(popup);
    return result === POPUP_RESULT.AFFIRMATIVE ? { deleteKeys: Boolean(checkbox.checked && removable.length) } : null;
}

/** Choose what to do with unsaved main-page changes; the caller owns saving and switching. */
export async function confirmUnsavedProfileSwitch({ current = null, target = null, draftName = null } = {}) {
    const root = element('div', { class: 'cw-dialog cw-editor cw-unsaved-profile-dialog' });
    const currentName = current ? current.name || '未命名方案' : draftName || '未保存连接';
    const targetName = target ? target.name || '未命名方案' : '未选择方案';
    const message = element('p', { text: `「${currentName}」有尚未保存的修改。切换到「${targetName}」前，请选择如何处理。` });
    message.style.overflowWrap = 'anywhere';
    root.append(element('h3', { text: '切换前保存修改？' }), message);
    const customButtons = [
        ...(current || draftName ? [{ text: '保存', tooltip: current ? '保存原方案并切换' : '保存新方案并切换', result: POPUP_RESULT.CUSTOM1, classes: ['cw-popup-action'] }] : []),
        { text: '另存', tooltip: '另存为新方案并切换', result: POPUP_RESULT.CUSTOM2, classes: ['cw-popup-action'] },
        { text: '不保存', tooltip: '不保存修改并切换', result: POPUP_RESULT.CUSTOM3, classes: ['cw-popup-action'] },
    ];
    const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: false, cancelButton: '取消', customButtons,
        defaultResult: POPUP_RESULT.NEGATIVE, allowEscapeClose: true,
    });
    popup.dlg.classList.add('cw-popup', 'cw-editor-popup', 'cw-unsaved-profile-popup');
    for (const control of popup.buttonControls.children) control.setAttribute('aria-label', control.title || control.textContent.trim());
    const result = await showThemedPopup(popup);
    if (result === POPUP_RESULT.CUSTOM1 && (current || draftName)) return 'save';
    if (result === POPUP_RESULT.CUSTOM2) return 'save-as';
    if (result === POPUP_RESULT.CUSTOM3) return 'discard';
    return 'cancel';
}
