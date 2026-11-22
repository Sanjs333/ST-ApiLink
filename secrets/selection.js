export function createSecretSelection() {
    const selected = new Set();
    let visible = new Set(), renamable = new Set();
    let visibleCount = 0, renameCount = 0, visibleRenamable = false;
    function set(key, checked) {
        if (selected.has(key) === checked) return;
        if (checked) selected.add(key); else selected.delete(key);
        const delta = checked ? 1 : -1;
        if (visible.has(key)) visibleCount += delta;
        if (renamable.has(key)) renameCount += delta;
    }
    return {
        has: key => selected.has(key), add: key => set(key, true), delete: key => set(key, false),
        clear() { selected.clear(); visibleCount = renameCount = 0; },
        get size() { return selected.size; },
        get visibleCount() { return visibleCount; },
        canRename: multi => multi ? renameCount > 0 : visibleRenamable,
        refresh(all, shown, eligible) {
            visible = shown; renamable = eligible;
            visibleCount = renameCount = 0;
            for (const key of selected) {
                if (!all.has(key)) { selected.delete(key); continue; }
                if (visible.has(key)) visibleCount++;
                if (renamable.has(key)) renameCount++;
            }
            visibleRenamable = false;
            for (const key of renamable) if (visible.has(key)) { visibleRenamable = true; break; }
        },
    };
}
