const CATALOG_OPTION = 'data-cw-vertex-model';
const CATALOG_GROUP = 'data-cw-vertex-catalog';

export function projectVertexModelCatalog(select, entries) {
    const selected = select.selectedOptions?.[0];
    const allowed = new Map(entries.map(entry => [entry.id, entry]));
    let group = [...select.children].find(node => node.hasAttribute(CATALOG_GROUP));
    for (const option of select.querySelectorAll(`option[${CATALOG_OPTION}]`)) {
        const entry = allowed.get(option.value);
        if (!entry && option !== selected) option.remove();
        else if (entry && option.textContent !== entry.label) option.textContent = entry.label || entry.id;
    }
    const existing = new Set([...select.options].map(option => option.value));
    for (const entry of entries) {
        if (existing.has(entry.id)) continue;
        if (!group) {
            group = select.ownerDocument.createElement('optgroup');
            group.label = 'Google 模型目录';
            group.setAttribute(CATALOG_GROUP, '');
            const before = [...select.children].find(node => node.tagName !== 'OPTION' || node.value);
            select.insertBefore(group, before ?? null);
        }
        const option = select.ownerDocument.createElement('option');
        option.value = entry.id;
        option.textContent = entry.label || entry.id;
        option.setAttribute(CATALOG_OPTION, '');
        group.append(option);
        existing.add(entry.id);
    }
    if (group && !group.children.length) group.remove();
    if (selected?.closest('select') === select && !selected.selected) select.selectedIndex = [...select.options].indexOf(selected);
}

export function clearVertexModelCatalog(select) {
    for (const option of select.querySelectorAll(`option[${CATALOG_OPTION}]`)) option.remove();
    for (const group of select.querySelectorAll(`optgroup[${CATALOG_GROUP}]`)) if (!group.children.length) group.remove();
}
