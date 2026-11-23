import { installSearchableSelects } from '../ui/select.js';
import { installNativeModelGrouping } from '../models/grouping.js';

const SINGLE_SELECT = ':not([multiple]):not([hidden]):not(.displayNone):not(.cw-merged-credential-hidden):not(#custom_credential_select)';
const API_SELECTORS = [`#rm_api_block select${SINGLE_SELECT}`, `#connection_profiles${SINGLE_SELECT}`];

/** Use native select controls to open the existing searchable dropdowns. */
export function installApiSelects({ root = document, onError = console.error } = {}) {
    const cleanupGroups = installNativeModelGrouping({ root, onError, groupedSelectors: ['#connection_profiles'] });
    let cleanupPickers;
    try {
        cleanupPickers = installSearchableSelects({ root, selectors: API_SELECTORS, autoGroup: true, replaceExisting: true, nativeControl: true, onError });
    } catch (error) {
        cleanupGroups();
        throw error;
    }
    return () => {
        try { cleanupPickers(); } finally { cleanupGroups(); }
    };
}
