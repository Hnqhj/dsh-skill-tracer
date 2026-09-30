/**
 * 技能轨迹 —— DeepSeek Harness host 半。
 *
 * 注册一个会话投影单元：从已提交的会话事件里折叠出"技能调用的过程与逻辑"
 * （目录、模型加载、用户手势、以及每次加载之后跟随的工具工作），经 api-proxy
 * 的 `session/projection` 帧整帧推给 Web 端 —— 客户端零折叠代码，右侧栏面板
 * 拿到的永远是宿主算好的完整值。
 *
 * 设计取向（沿用 dsh-asset-library / dsh-tool-todo 的成熟做法）：
 *  - `inject` 只声明 `sessionProjections`：投影是本插件唯一的产出，注册表
 *    缺席的 headless 组装里插件整体保持未激活，而不是带着半个功能活着。
 *  - 折叠是纯函数（lib/trace.js）：同步、可重放、对无关事件返回同一引用。
 *    会话日志是唯一真源，重启后首次触达时由注册表从日志重放重建。
 *  - 不注册任何 Agent 工具、不改提示词、不碰执行流水线：观测性插件必须
 *    对模型零可见、对 KV Cache 零影响。
 */
import { Config, resolveConfig } from './lib/config.js';
import {
    PROJECTION_KEY,
    STATE_VERSION,
    initialState,
    createFold,
    stateSchema,
    viewSchema,
} from './lib/trace.js';

/** 插件名（loader 行的 id 与它一致）。 */
export const name = 'skill-tracer';

/** 投影注册表是硬依赖；缺席说明该 profile 根本没有会话投影能力。 */
export const inject = ['sessionProjections'];

export { Config };

/**
 * 激活插件。
 *
 * @param ctx - host 插件上下文。
 * @param config - 已由 schema 补全的配置（缺失时这里再补一次）。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const fold = createFold(resolved);
    ctx.sessionProjections.register({
        key: PROJECTION_KEY,
        stateSchema,
        init: initialState,
        apply: fold,
        // view 就是状态本身：状态已经是纯 JSON、UI 量级（裁剪上限兜底），
        // 再造一个视图层只会多一个失同步的机会。
        wire: { viewSchema, view: (state) => state },
        stateVersion: STATE_VERSION,
    });
    ctx.logger.info(`skill-tracer: projection "${PROJECTION_KEY}" registered (maxTurns=${resolved.maxTurns}, maxItems=${resolved.maxItems})`);
}
