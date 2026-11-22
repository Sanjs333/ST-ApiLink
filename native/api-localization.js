const API_LOCALE = {
    'API': 'API 来源',
    'OpenAI-compatible': '兼容 OpenAI',
    'Other Providers': '其他服务商',
    'SiliconFlow Endpoint': '硅基流动接入点',
    'Global (siliconflow.com)': '国际站（siliconflow.com）',
    'China (siliconflow.cn)': '中国站（siliconflow.cn）',
    'MiniMax API Key': 'MiniMax API 密钥',
    'MiniMax Endpoint': 'MiniMax 接入点',
    'Global (minimax.io)': '国际站（minimax.io）',
    'China (minimaxi.com)': '中国站（minimaxi.com）',
    'MiniMax Model': 'MiniMax 模型',
    'Force NanoGPT pay-as-you-go billing for this request.': '强制本次请求使用 NanoGPT 按量计费。',
    'Use pay-as-you-go billing': '使用按量计费',
    'Cloudflare Workers AI API Key': 'Cloudflare Workers AI API 密钥',
    'Cloudflare Account ID': 'Cloudflare 账户 ID',
    'e.g. 023e105f4ecef8ad9ca31a8372d0c353': '例如 023e105f4ecef8ad9ca31a8372d0c353',
    'Workers AI Model': 'Workers AI 模型',
    'Documentation': '文档',
    'Support': '技术支持',
    'Added by the extension': '由扩展提供',
    'Pollinations Endpoint': 'Pollinations 接入点',
    'Anonymous (No Key)': '匿名使用（无需密钥）',
    'Authenticated (API Key)': '身份验证（需要 API 密钥）',
    'Model Sorting': '模型排序',
    'Prompt Price (cheapest)': '输入价格（由低到高）',
    'Completion Price (cheapest)': '输出价格（由低到高）',
    'This setup does not accept a key.': '此连接配置不接受密钥。',
    'Could not save the connection key.': '无法保存连接密钥。',
    'Unlabeled': '未命名',
    'Reset provider defaults?': '恢复服务商默认设置？',
    'This replaces the connection fields. Your stored keys are kept.': '此操作会覆盖当前连接设置，已保存的密钥将保留。',
    'Forget saved setup?': '清理已保存的服务商设置？',
    'Please provide a name for the new connection profile.': '请输入新连接方案的名称。',
    'No profile selected.': '未选择连接方案。',
};

const PROVIDER_WARNING = 'Deselect inapplicable provider(s) or select an applicable provider to avoid a 404 error.';
const ATTRIBUTES = [
    ['#openrouter_provider_warning_text, #openrouter_provider_warning_chat, #nanogpt_provider_warning', 'title', PROVIDER_WARNING, '取消选择不适用的服务商，或选择适用的服务商，以避免 404 错误。'],
    ['#vertexai_express_project_id', 'placeholder', 'Enter your Project ID', '请输入项目 ID'],
    ['#vertexai_region', 'placeholder', 'e.g., global, us-central1, europe-west1, asia-northeast1', '例如 global、us-central1、europe-west1、asia-northeast1'],
];

// These messages bypass the host's translation API. Match whole strings only.
const POPUP_MESSAGES = {
    'Preset name already exists. Overwrite?': '预设名称已存在，要覆盖吗？',
};
const TOAST_MESSAGES = {
    'Connection profile reloaded': '已重新加载连接方案',
    'Connection profile updated': '已更新连接方案',
    'Connection profile renamed.': '已重命名连接方案。',
    'Name cannot be empty.': '名称不能为空。',
    'A profile with the same name already exists.': '已存在同名连接方案。',
    'Included settings list updated': '已更新随方案保存的设置',
    'Press "Update" to record them into the profile.': '点击“更新”将这些设置保存到连接方案。',
};

export { API_LOCALE };

export function installApiLocalization(locale) {
    if (locale !== 'zh-cn') return () => {};

    const restored = [];
    for (const [selector, attribute, original, localized] of ATTRIBUTES) {
        for (const node of document.querySelectorAll(selector)) {
            if (node.getAttribute(attribute) !== original) continue;
            node.setAttribute(attribute, localized);
            restored.push(() => {
                if (node.getAttribute(attribute) === localized) node.setAttribute(attribute, original);
            });
        }
    }

    const selector = 'dialog.popup .popup-content, #dialogue_popup_text, #toast-container .toast-title, #toast-container .toast-message';
    function localize(node) {
        const dictionary = node.matches('.toast-title, .toast-message') ? TOAST_MESSAGES : POPUP_MESSAGES;
        if (node.children.length) return;
        const text = node.textContent.trim();
        if (Object.hasOwn(dictionary, text)) node.textContent = dictionary[text];
    }
    const observer = new MutationObserver(records => {
        for (const { target, addedNodes } of records) {
            if (target.matches?.(selector)) localize(target);
            for (const node of addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.matches(selector)) localize(node);
                node.querySelectorAll(selector).forEach(localize);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
        observer.disconnect();
        restored.forEach(restore => restore());
    };
}
