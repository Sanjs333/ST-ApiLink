/** Restore the previous selection on servers predating the activate:false write option. */
export async function writeInactiveSecret({ key, value, label, getSecrets, request, refresh, notify, pause = () => () => {} }) {
    const release = pause();
    try {
        const previousId = getSecrets()[key]?.find(entry => entry.active)?.id;
        const response = await request('write', { key, value, label, activate: false });
        const { id } = await response.json();
        if (typeof id !== 'string' || !id) throw new Error('密钥未能保存，请重试。');
        await refresh();
        if (!getSecrets()[key]?.some(entry => entry.id === id)) throw new Error('密钥已写入，但无法确认密钥列表，请刷新后检查。');
        if (previousId && !getSecrets()[key]?.some(entry => entry.id === previousId && entry.active)) {
            if (!getSecrets()[key]?.some(entry => entry.id === previousId)) throw new Error('原密钥已变更，请刷新后检查当前连接。');
            await request('rotate', { key, id: previousId });
            await refresh();
            if (!getSecrets()[key]?.some(entry => entry.id === previousId && entry.active)) throw new Error('密钥已保存，但原密钥未能恢复，请重新选择。');
        }
        await notify(key);
        return id;
    } finally { release(); }
}
