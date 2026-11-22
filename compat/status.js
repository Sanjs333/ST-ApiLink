import * as script from '../../../../../script.js';

export function cancelStatusCheck(reason = 'Connection changed') {
    if (typeof script.cancelStatusCheck === 'function') return script.cancelStatusCheck(reason);
    // The old main-API handler cancels and renews its private status controller.
    const select = globalThis.document?.getElementById('main_api');
    select?.dispatchEvent(new Event('change', { bubbles: true }));
    script.setOnlineStatus('no_connection');
}
