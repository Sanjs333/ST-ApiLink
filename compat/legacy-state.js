/** Old hosts reload only known OpenAI fields; store extension-owned state with extension settings. */
export function linkLegacyState(settings, getExtensionSettings) {
    const original = Object.getOwnPropertyDescriptor(settings, 'custom_provider_state');
    const initial = settings.custom_provider_state;
    const ownSettings = () => {
        const extensions = getExtensionSettings();
        return extensions.connectionWorkbench ??= { version: 1, models: {} };
    };
    if (initial !== undefined) ownSettings().legacyCustomState = initial;
    Object.defineProperty(settings, 'custom_provider_state', {
        configurable: true, enumerable: true,
        get: () => ownSettings().legacyCustomState,
        set: value => { ownSettings().legacyCustomState = value; },
    });
    return () => {
        const value = settings.custom_provider_state;
        if (original && !('value' in original)) {
            Object.defineProperty(settings, 'custom_provider_state', original);
            if (original.set && settings.custom_provider_state !== value) settings.custom_provider_state = value;
        } else {
            Object.defineProperty(settings, 'custom_provider_state', original ? { ...original, value }
                : { configurable: true, enumerable: true, writable: true, value });
        }
    };
}
