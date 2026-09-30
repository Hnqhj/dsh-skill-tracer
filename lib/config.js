/**
 * 技能轨迹配置。
 *
 * 只有两个旋钮，都在约束"投影值有多大"：轨迹是随 `session/projection` 帧
 * 整帧推送的（全量值规则），所以状态必须保持 UI 量级——裁剪上限就是安全阀。
 */
import z from '@deepseek-ai/schemastery';

/** 出厂默认值；`apply()` 用它补齐未经 schema 的配置。 */
export const SKILL_TRACER_DEFAULTS = {
    /** 每个会话的轨迹最多保留多少个轮次（保留最新的）。 */
    maxTurns: 8,
    /** 单个轮次里最多保留多少条条目（技能加载 + 工具调用，保留最新的）。 */
    maxItems: 120,
    /** 技能目录里单条描述的最长字符数（超出截断，避免帧膨胀）。 */
    catalogDescriptionMax: 200,
};

/**
 * 配置 schema。profile 里那行插件写成 `{}` 时，全部走默认值。
 */
export const Config = z.object({
    maxTurns: z.natural().min(1).max(64).default(SKILL_TRACER_DEFAULTS.maxTurns),
    maxItems: z.natural().min(10).max(1000).default(SKILL_TRACER_DEFAULTS.maxItems),
    catalogDescriptionMax: z.natural().min(40).max(500).default(SKILL_TRACER_DEFAULTS.catalogDescriptionMax),
});

/**
 * 把可能不完整的配置补成完整配置（调用方绕过 schema 直呼 `apply()` 时的兜底）。
 *
 * @param config - `apply()` 收到的原始配置。
 * @returns 每个字段都存在的配置对象。
 */
export function resolveConfig(config) {
    const merged = { ...SKILL_TRACER_DEFAULTS, ...(config ?? {}) };
    return {
        maxTurns: clampInteger(merged.maxTurns, SKILL_TRACER_DEFAULTS.maxTurns, 1, 64),
        maxItems: clampInteger(merged.maxItems, SKILL_TRACER_DEFAULTS.maxItems, 10, 1000),
        catalogDescriptionMax: clampInteger(merged.catalogDescriptionMax, SKILL_TRACER_DEFAULTS.catalogDescriptionMax, 40, 500),
    };
}

/** 整数收口：非有限值回退默认，范围外夹紧。 */
function clampInteger(value, fallback, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(numeric)));
}
