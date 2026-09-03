const fs = require('fs');
const path = require('path');

/**
 * 动态解析提示词模板
 * @param {string} originalPrompt 软件传过来的原始系统提示词
 * @param {string} templatePrompt 用户自定义的提示词模板内容
 * @returns {string} 替换占位符后的最终提示词
 */
function resolveDynamicPrompt(originalPrompt, templatePrompt) {
    if (!originalPrompt || !templatePrompt) {
        return templatePrompt;
    }

    const configPath = path.join(__dirname, 'prompt-mappings.json');
    if (!fs.existsSync(configPath)) {
        console.warn('[VCPBridgeServer Parser] prompt-mappings.json not found, skipping dynamic parsing.');
        return templatePrompt;
    }

    try {
        const configRaw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configRaw);
        const mappings = config.mappings || [];

        let renderedPrompt = templatePrompt;

        // 遍历配置中的所有映射规则
        for (const rule of mappings) {
            if (!rule.placeholder || !rule.regex) continue;

            // 优化：如果模板中根本没写这个占位符，直接跳过正则匹配以提升性能
            if (!renderedPrompt.includes(rule.placeholder)) {
                continue;
            }

            try {
                // 动态构建正则表达式
                const regex = new RegExp(rule.regex, rule.flags || '');
                const match = originalPrompt.match(regex);

                // 匹配值处理：有捕获组则取捕获组，无则取全匹配，未匹配到则设为空字符
                let value = '';
                if (match) {
                    value = match[1] !== undefined ? match[1].trim() : match[0].trim();
                }

                // 将占位符安全地进行正则表达式字符转义，然后全局替换
                const escapedPlaceholder = rule.placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const replaceRegex = new RegExp(escapedPlaceholder, 'g');
                renderedPrompt = renderedPrompt.replace(replaceRegex, value);

            } catch (ruleErr) {
                console.error(`[VCPBridgeServer Parser] Error processing rule [${rule.placeholder}]: ${ruleErr.message}`);
            }
        }

        return renderedPrompt;

    } catch (err) {
        console.error(`[VCPBridgeServer Parser] Failed to read or parse prompt-mappings.json: ${err.message}`);
        return templatePrompt;
    }
}

module.exports = {
    resolveDynamicPrompt
};
