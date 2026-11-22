

export const PARAMETER_FIELDS = Object.freeze(['custom_include_headers', 'custom_include_body', 'custom_exclude_body']);
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)$/i;
const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeParameterFields(fields = {}) {
    if (!isMapping(fields)) throw new Error('附加参数必须包含文本字段。');
    return Object.fromEntries(PARAMETER_FIELDS.map(key => {
        const value = Object.hasOwn(fields, key) ? fields[key] : '';
        if (typeof value !== 'string') throw new Error('附加参数必须是文本。');
        return [key, value];
    }));
}

export function validateParameterFields(fields, parseYaml) {
    const normalized = normalizeParameterFields(fields);
    if (typeof parseYaml !== 'function') return normalized;
    for (const key of PARAMETER_FIELDS) {
        const text = normalized[key];
        if (!text.trim()) continue;
        let parsed;
        const label = key === 'custom_include_headers' ? '附加请求头' : key === 'custom_include_body' ? '附加请求体' : '排除请求体字段';
        try { parsed = parseYaml(text); }
        catch { throw new Error(label + '格式不正确，请使用 YAML 或 JSON。'); }
        if (key === 'custom_exclude_body') {
            const valid = typeof parsed === 'string' && parsed.trim()
                || isMapping(parsed)
                || Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.trim());
            if (!valid) throw new Error('排除请求体字段请使用字段名称、YAML 列表或键值对象。');
            continue;
        }
        const mappings = Array.isArray(parsed) ? parsed : [parsed];
        if (mappings.some(item => !isMapping(item))) throw new Error(label + '需要键值对，例如 stream_options: {}。');
        if (key === 'custom_include_headers' && mappings.some(item => Object.keys(item).some(name => AUTH_HEADER.test(name)))) {
            throw new Error('认证请求头请通过密钥选择设置，附加请求头不能覆盖它。');
        }
    }
    return normalized;
}

function presetName(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('请输入附加参数预设名称。');
    if (value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('附加参数预设名称最多 256 个字符，不能包含控制字符。');
    return value.trim();
}

// Connections retain independent copies of preset fields.
export function createParameterPresetStore({ getSettings, saveSettings, makeId = () => globalThis.crypto.randomUUID(), parseYaml } = {}) {
    if (typeof getSettings !== 'function' || typeof saveSettings !== 'function' || typeof makeId !== 'function') {
        throw new Error('附加参数预设需要酒馆设置接口。');
    }
    const subscribers = new Set();
    function list() {
        const saved = getSettings()?.parameterPresets;
        if (!Array.isArray(saved)) return [];
        const ids = new Set(), result = [];
        for (const preset of saved) {
            try {
                if (typeof preset?.id !== 'string' || !preset.id || ids.has(preset.id)) continue;
                const entry = { id: preset.id, name: presetName(preset.name), fields: normalizeParameterFields(preset.fields) };
                ids.add(entry.id); result.push(entry);
            } catch { /* A malformed imported record does not hide the remaining presets. */ }
        }
        return result;
    }
    function write(next) {
        const settings = getSettings();
        if (!isMapping(settings)) throw new Error('附加参数预设设置暂不可用。');
        const hadPresets = Object.hasOwn(settings, 'parameterPresets');
        const previous = settings.parameterPresets;
        settings.parameterPresets = next;
        try {
            if (saveSettings() === false) throw new Error('附加参数预设未能保存，请重试。');
        } catch (error) {
            if (hadPresets) settings.parameterPresets = previous;
            else delete settings.parameterPresets;
            throw error;
        }
        for (const listener of subscribers) { try { listener(); } catch { /* UI observers cannot interrupt a completed save. */ } }
    }
    return {
        list,
        validate(fields) { return validateParameterFields(fields, parseYaml); },
        get(id) { return list().find(preset => preset.id === id) ?? null; },
        save({ id, name, fields } = {}) {
            const entries = list(), normalizedName = presetName(name);
            const index = id === undefined ? -1 : entries.findIndex(preset => preset.id === id);
            if (id !== undefined && index < 0) throw new Error('附加参数预设已不存在，请重新选择。');
            if (entries.some(preset => preset.id !== id && preset.name === normalizedName)) throw new Error('附加参数预设名称已存在，请使用其他名称。');
            const presetId = id ?? makeId();
            if (typeof presetId !== 'string' || !presetId || index < 0 && entries.some(preset => preset.id === presetId)) {
                throw new Error('未能生成附加参数预设 ID，请重试。');
            }
            const preset = { id: presetId, name: normalizedName, fields: validateParameterFields(fields, parseYaml) };
            if (index < 0) entries.push(preset); else entries[index] = preset;
            write(entries);
            return structuredClone(preset);
        },
        remove(id) {
            const entries = list(), remaining = entries.filter(preset => preset.id !== id);
            if (remaining.length === entries.length) return false;
            write(remaining); return true;
        },
        match(fields) {
            const normalized = normalizeParameterFields(fields);
            return list().find(preset => PARAMETER_FIELDS.every(key => preset.fields[key] === normalized[key])) ?? null;
        },
        subscribe(listener) {
            if (typeof listener !== 'function') throw new Error('附加参数预设监听器必须是函数。');
            subscribers.add(listener); return () => subscribers.delete(listener);
        },
    };
}
