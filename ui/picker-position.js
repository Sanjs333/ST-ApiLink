/** Keep picker panels in viewport coordinates, including inside modal dialogs. */
export function createPickerPositioner(panel, anchor, { maxHeight = 430 } = {}) {
    const documentRef = anchor.ownerDocument;
    const windowRef = documentRef.defaultView;
    const popover = typeof panel.showPopover === 'function';
    if (popover) panel.setAttribute('popover', 'manual');
    let owner = null, frame = null;
    const listeners = [];
    const listen = (target, type, callback, options) => {
        if (!target) return;
        target.addEventListener(type, callback, options);
        listeners.push(() => target.removeEventListener(type, callback, options));
    };
    const setStyle = (name, value) => {
        if (panel.style[name] !== value) panel.style[name] = value;
    };

    function position() {
        if (panel.hidden || !anchor.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const viewport = windowRef.visualViewport;
        const viewportTop = viewport?.offsetTop ?? 0, viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportHeight = viewport?.height ?? windowRef.innerHeight, viewportWidth = viewport?.width ?? windowRef.innerWidth;
        const edge = 8, gap = 4;
        const width = Math.max(0, Math.min(rect.width, viewportWidth - edge * 2));
        const below = viewportTop + viewportHeight - rect.bottom - edge - gap;
        const above = rect.top - viewportTop - edge - gap;
        const useAbove = below < 240 && above > below;
        const height = Math.max(0, Math.min(maxHeight, useAbove ? above : below));
        // Without Popover, the dialog is the absolute positioning containing block.
        const container = popover ? null : owner;
        const ownerRect = container?.getBoundingClientRect();
        const scaleX = container && container.offsetWidth ? ownerRect.width / container.offsetWidth : 1;
        const scaleY = container && container.offsetHeight ? ownerRect.height / container.offsetHeight : 1;
        setStyle('position', container ? 'absolute' : 'fixed');
        setStyle('width', `${width / (scaleX || 1)}px`);
        setStyle('maxHeight', `${height / (scaleY || 1)}px`);
        setStyle('bottom', '');
        const panelHeight = panel.getBoundingClientRect().height;
        const left = Math.max(viewportLeft + edge, Math.min(rect.left, viewportLeft + viewportWidth - width - edge));
        const top = Math.max(viewportTop + edge, Math.min(useAbove ? rect.top - panelHeight - gap : rect.bottom + gap,
            viewportTop + viewportHeight - panelHeight - edge));
        setStyle('left', `${container ? (left - ownerRect.left) / (scaleX || 1) - container.clientLeft + container.scrollLeft : left}px`);
        setStyle('top', `${container ? (top - ownerRect.top) / (scaleY || 1) - container.clientTop + container.scrollTop : top}px`);
        if (!popover && !container) {
            // The host transforms html; fixed descendants then move with page scrolling.
            const actual = panel.getBoundingClientRect();
            setStyle('left', `${left + left - actual.left}px`);
            setStyle('top', `${top + top - actual.top}px`);
        }
    }

    function schedule(event) {
        if (panel.hidden || event?.type === 'scroll' && event.target instanceof windowRef.Node && panel.contains(event.target) || frame !== null) return;
        // Popup viewport listeners can move the dialog later in the same event.
        frame = windowRef.requestAnimationFrame(() => {
            frame = null;
            position();
            if (owner?.getAnimations?.().some(animation => animation.playState === 'running')) schedule();
        });
    }
    const resizeObserver = windowRef.ResizeObserver ? new windowRef.ResizeObserver(() => schedule()) : null;
    const ownerObserver = windowRef.MutationObserver ? new windowRef.MutationObserver(() => schedule()) : null;

    function hide() {
        if (popover && panel.matches(':popover-open')) panel.hidePopover();
        panel.hidden = true;
        if (frame !== null) windowRef.cancelAnimationFrame(frame);
        frame = null;
        resizeObserver?.disconnect();
        ownerObserver?.disconnect();
        for (const remove of listeners.splice(0)) remove();
    }

    function show() {
        if (!panel.hidden) { position(); schedule(); return; }
        owner = anchor.closest('dialog');
        const parent = owner ?? documentRef.body;
        if (panel.parentElement !== parent) parent.append(panel);
        panel.hidden = false;
        if (popover) panel.showPopover();
        listen(windowRef, 'scroll', schedule, true);
        listen(windowRef, 'resize', schedule);
        listen(windowRef.visualViewport, 'resize', schedule);
        listen(windowRef.visualViewport, 'scroll', schedule);
        if (owner) {
            ownerObserver?.observe(owner, { attributes: true, attributeFilter: ['style', 'class', 'open', 'opening', 'closing'] });
            for (const type of ['animationstart', 'animationend', 'transitionrun', 'transitionend']) listen(owner, type, schedule);
            resizeObserver?.observe(owner);
            listen(owner, 'close', hide);
        }
        resizeObserver?.observe(anchor);
        resizeObserver?.observe(panel);
        position();
        schedule();
    }

    return { show, hide, position, cleanup: hide };
}
