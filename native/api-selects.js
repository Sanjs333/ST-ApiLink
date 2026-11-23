import { installNativeModelGrouping } from '../models/grouping.js';

/** Keep the main API page's native controls so host themes and select stylers own their appearance. */
export function installApiSelects({ root = document, onError = console.error } = {}) {
    return installNativeModelGrouping({ root, onError, groupedSelectors: ['#connection_profiles'] });
}
