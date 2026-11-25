/** Route user selections through the same runtime as the profile manager and reload button. */
export function createProfileSelectionHandler({ runtime, isDispatching, isPending, setPending, onError }) {
    return event => {
        // Older hosts dispatch their own change event while executing /profile.
        // Picker clicks are synthetic too, but remain user actions even during a command.
        if (isDispatching() && !event.isTrusted && !event.detail?.connectionWorkbenchUserSelection) return;
        const stop = () => { event.preventDefault(); event.stopImmediatePropagation(); };
        const restore = () => { event.target.value = runtime.selected()?.id ?? ''; };
        if (isPending() || runtime.isSwitching()) { stop(); restore(); return; }
        stop();
        const id = event.target.value;
        if (id === (runtime.selected()?.id ?? '')) return;
        const profile = runtime.profiles().find(entry => entry.id === id);
        restore();
        try {
            if (id && !profile) throw new Error('此连接方案已不存在，请重新选择。');
            if (profile) runtime.validate(profile);
        } catch (error) { onError(error); return; }
        setPending(true);
        void (async () => {
            try { if (profile) await runtime.select(profile); else await runtime.deselect(); }
            catch (error) { onError(error); }
            finally { setPending(false); }
        })();
    };
}
