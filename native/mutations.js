function containsMatch(nodes, selector) {
    for (const node of nodes) {
        if (node.nodeType === 1 && (node.matches(selector) || (node.childElementCount && node.querySelector(selector)))) return true;
    }
    return false;
}

export function touchesSelector(record, selector, includeTarget = false) {
    if (includeTarget) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target?.closest(selector)) return true;
    }
    return containsMatch(record.addedNodes, selector) || containsMatch(record.removedNodes, selector);
}
