import { event_types as nativeEvents } from '../../../../../script.js';

// Older hosts have no Custom connection event. Keep our fallback private to the extension.
export const event_types = {
    ...nativeEvents,
    CUSTOM_CONNECTION_CHANGED: nativeEvents.CUSTOM_CONNECTION_CHANGED ?? 'connection_workbench_custom_connection_changed',
};
