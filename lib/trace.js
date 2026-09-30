/**
 * 技能轨迹的投影单元：状态 schema + 事件折叠。
 *
 * 会话日志是唯一真源（官方实践第一原则），这里只做纯数学：`apply(state, event)`
 * 同步、可重放、对无关事件返回**同一个引用**（同引用即无工作）。一切状态都从
 * 既有事件类型派生 —— `tool/call`、`tool/result`、`user/message`、`turn/*` ——
 * 绝不追加自定义事件类型（未带 `ignorable` 的新类型会让会话拒绝重开）。
 *
 * 两条技能调用路径都被覆盖：
 *  1. 模型加载：`tool/call`（name === 'skill'）→ 对应 `tool/result` 收尾；
 *  2. 用户手势：用户消息里出现 `/名称` 时，宿主注入的指令上下文带着
 *     `source.kind === 'skill-invocation'` 落成 `user/message` 事件。
 *
 * "过程和逻辑"的呈现口径：轮次（turn）是天然的分镜 —— 每个轮次里，一次技能
 * 加载开启一个"阶段"，其后的普通工具调用都属于这个阶段，直到下一次加载。
 *
 * 事件形状（来自真实会话日志与 dsh-session 源码，v4 log）：
 *  - turn/start  data: { turn: number }
 *  - turn/end    data: { turn, reason?: { kind } }
 *  - tool/call   data: { turn, step, callId, name, arguments: string }
 *  - tool/result data: { turn, step, message: { source: { callId }, isError }, error?: { code } }
 *  - user/message data: { content: [{ type: 'text', text }], source: { kind, name? } }
 */
import { z } from 'zod';

/** 投影 key；客户端 `useProjection(key)` 用同一个字符串。 */
export const PROJECTION_KEY = 'skill-trace';

/** 状态字段或折叠语义变化时递增；持久投影缓存据此丢弃旧检查点。 */
export const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// 状态 schema（同时也是 wire view schema：view 就是状态本身）
// ---------------------------------------------------------------------------

const catalogEntrySchema = z.object({
    name: z.string(),
    description: z.string(),
});

const traceItemSchema = z.object({
    /** 'skill' = 模型经 `skill` 工具加载；'gesture' = 用户 `/名称`；'tool' = 普通工具调用。 */
    kind: z.union([z.literal('skill'), z.literal('gesture'), z.literal('tool')]),
    /** 工具调用的关联 id；手势没有调用 id，用 `gesture:<seq>` 占位。 */
    callId: z.string(),
    /** 原始工具名；手势与纯技能条目没有对应工具时为空串。 */
    toolName: z.string(),
    /** 加载（或手势调用）的技能名。 */
    skillName: z.string().optional(),
    /** 谁发起的加载：模型自主 / 用户显式。 */
    via: z.union([z.literal('model'), z.literal('user')]).optional(),
    status: z.union([z.literal('running'), z.literal('ok'), z.literal('error')]),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    /** 失败时宿主给出的稳定错误码（如 TOOL_OUTCOME_UNKNOWN）。 */
    errorCode: z.string().optional(),
});

const traceTurnSchema = z.object({
    turn: z.number(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    /** 轮次结束原因（`turn/end` 的 reason.kind，如 'completed' / 'aborted'）。 */
    endReason: z.string().optional(),
    /** true = 先于任何 turn/start 到达的事件被归入的合成轮次。 */
    pending: z.literal(true).optional(),
    items: z.array(traceItemSchema),
});

const traceStateSchema = z.object({
    /** 最近一次发布的技能目录（名称 + 描述），空数组 = 会话无可调用技能。 */
    catalog: z.array(catalogEntrySchema),
    catalogAt: z.number().nullable(),
    activeTurn: z.number().nullable(),
    turns: z.array(traceTurnSchema),
});

export const stateSchema = traceStateSchema;
export const viewSchema = traceStateSchema;

/** 初始状态：空目录、无轮次。 */
export function initialState() {
    return { catalog: [], catalogAt: null, activeTurn: null, turns: [] };
}

// ---------------------------------------------------------------------------
// 折叠
// ---------------------------------------------------------------------------

/**
 * 构建折叠函数（闭包携带裁剪上限，避免每次 apply 传参）。
 *
 * @param bounds - `{ maxTurns, maxItems, catalogDescriptionMax }`。
 * @returns `(state, event) => nextState`。
 */
export function createFold(bounds) {
    return (state, event) => {
        switch (event.type) {
            case 'turn/start': return onTurnStart(state, event, bounds);
            case 'turn/end': return onTurnEnd(state, event);
            case 'tool/call': return onToolCall(state, event, bounds);
            case 'tool/result': return onToolResult(state, event);
            case 'user/message': return onUserMessage(state, event, bounds);
            default: return state;
        }
    };
}

/** 轮次开始：开一个新分镜；裁剪只保留最新 N 个轮次。 */
function onTurnStart(state, event, bounds) {
    const turn = { turn: event.data.turn, startedAt: event.time, endedAt: null, items: [] };
    const turns = [...state.turns, turn].slice(-bounds.maxTurns);
    return { ...state, activeTurn: event.data.turn, turns };
}

/** 轮次结束：闭合分镜并记录原因；对已裁剪掉的轮次只清 activeTurn。 */
function onTurnEnd(state, event) {
    if (state.activeTurn === null || state.activeTurn !== event.data.turn) return state;
    let changed = state.activeTurn !== null;
    const reason = event.data.reason;
    const endReason = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : undefined;
    const turns = state.turns.map((entry) => {
        if (entry.turn !== event.data.turn || entry.endedAt !== null) return entry;
        changed = true;
        return { ...entry, endedAt: event.time, ...(endReason !== undefined ? { endReason } : {}) };
    });
    if (!changed) return state;
    return { ...state, activeTurn: null, turns };
}

/** 工具调用：skill 工具解析出技能名并标记 kind；其余是阶段内的普通步骤。 */
function onToolCall(state, event, bounds) {
    const data = event.data;
    if (typeof data.callId !== 'string' || data.callId === '' || typeof data.name !== 'string') return state;
    const isSkill = data.name === 'skill';
    const item = isSkill
        ? {
            kind: 'skill',
            callId: data.callId,
            toolName: data.name,
            skillName: parseSkillName(data.arguments),
            via: 'model',
            status: 'running',
            startedAt: event.time,
            endedAt: null,
        }
        : {
            kind: 'tool',
            callId: data.callId,
            toolName: data.name,
            status: 'running',
            startedAt: event.time,
            endedAt: null,
        };
    return appendItem(state, item, bounds);
}

/** 工具结果：按 callId 配对闭合；配不上（理论上只在日志异常时）就忽略。 */
function onToolResult(state, event) {
    const message = event.data.message;
    const callId = message?.source?.callId ?? message?.toolCallId;
    if (typeof callId !== 'string' || callId === '') return state;
    const isError = message?.isError === true;
    const errorCode = event.data.error !== null && typeof event.data.error === 'object' && typeof event.data.error.code === 'string'
        ? event.data.error.code
        : undefined;
    let changed = false;
    const turns = state.turns.map((entry) => {
        const index = entry.items.findIndex((item) => item.callId === callId && item.status === 'running');
        if (index === -1) return entry;
        changed = true;
        const items = entry.items.slice();
        const item = items[index];
        items[index] = {
            ...item,
            status: isError ? 'error' : 'ok',
            endedAt: event.time,
            ...(isError && errorCode !== undefined ? { errorCode } : {}),
        };
        return { ...entry, items };
    });
    return changed ? { ...state, turns } : state;
}

/**
 * 用户消息：技能目录的发布/替换，以及 `/名称` 手势注入。
 *
 * 目录消息由 dsh-tool-skill 在 pre-step 以 user 角色进入步骤并落日志，是
 * "模型此刻能看见哪些技能"的真源；空目录（全部停用）同样要覆盖旧值。
 */
function onUserMessage(state, event, bounds) {
    const source = event.data.source;
    if (source === null || typeof source !== 'object') return state;
    if (source.kind === 'skill-catalog') {
        const catalog = parseCatalog(event.data.content, bounds.catalogDescriptionMax);
        if (catalog === null) return state;
        return { ...state, catalog, catalogAt: event.seq };
    }
    if (source.kind === 'skill-invocation' && typeof source.name === 'string' && source.name !== '') {
        return appendItem(state, {
            kind: 'gesture',
            callId: `gesture:${event.seq}`,
            toolName: '',
            skillName: source.name,
            via: 'user',
            // 手势注入发生在 pre-step，指令已经进入该步骤 —— 对轨迹而言是即成事实。
            status: 'ok',
            startedAt: event.time,
            endedAt: event.time,
        }, bounds);
    }
    return state;
}

/** 把条目追加进当前打开的轮次；没有打开的轮次时归入（或创建）合成轮次。 */
function appendItem(state, item, bounds) {
    const open = state.turns.findLast((entry) => entry.turn === state.activeTurn && entry.endedAt === null);
    if (open !== undefined) {
        const turns = state.turns.map((entry) => entry === open
            ? { ...entry, items: trimItems([...entry.items, item], bounds.maxItems) }
            : entry);
        return { ...state, turns };
    }
    const last = state.turns.at(-1);
    if (last !== undefined && last.pending === true) {
        const turns = [...state.turns.slice(0, -1), { ...last, items: trimItems([...last.items, item], bounds.maxItems) }];
        return { ...state, turns };
    }
    const pendingTurn = { turn: 0, startedAt: item.startedAt, endedAt: item.startedAt, pending: true, items: [item] };
    return { ...state, turns: [...state.turns, pendingTurn].slice(-bounds.maxTurns) };
}

/** 条目裁剪：保留最新的 N 条（技能节点可能被裁掉，渲染端把孤儿工具归入"前置"组）。 */
function trimItems(items, maxItems) {
    return items.length <= maxItems ? items : items.slice(-maxItems);
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

/**
 * 从 `skill` 工具的调用参数（JSON 字符串）里取技能名。
 *
 * `arguments` 在日志里就是模型发出的原始串；正常情况 `JSON.parse` 直取
 * `name` 字段，解析失败再退到正则 —— 只影响展示，不影响折叠本身。
 */
function parseSkillName(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.name === 'string' && parsed.name.trim() !== '') {
            return parsed.name.trim();
        }
    } catch {
        // 落到正则兜底
    }
    const match = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(raw);
    if (match === null) return undefined;
    try {
        const decoded = JSON.parse(`"${match[1]}"`);
        return typeof decoded === 'string' && decoded.trim() !== '' ? decoded.trim() : undefined;
    } catch {
        return match[1];
    }
}

/**
 * 从目录消息的文本内容里解析技能条目。
 *
 * 目录形态来自 dsh-tool-skill 的模板：`<available_skills>` 块内每行一条
 * `` - `名称`: 描述 ``。返回 `null` 表示"这不是一份我们能读懂的目录消息"
 * （保持状态不变）；返回数组（可为空）表示一次完整的目录替换。
 */
function parseCatalog(content, descriptionMax) {
    const text = contentText(content);
    if (text === '') return null;
    const block = /<available_skills>([\s\S]*?)<\/available_skills>/u.exec(text);
    if (block === null) {
        // 空目录的替换消息没有 available_skills 块，只有一句明确的停用说明。
        return /No skills are currently available/u.test(text) ? [] : null;
    }
    const entries = [];
    const linePattern = /^\s*[-*]\s*`([^`]+)`\s*:\s*(.+?)\s*$/gmu;
    for (const match of block[1].matchAll(linePattern)) {
        const name = match[1].trim();
        if (name === '') continue;
        entries.push({ name, description: clip(match[2], descriptionMax) });
    }
    return entries;
}

/** 拼接消息文本块（目录消息全部是 text 块）。 */
function contentText(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.join('\n');
}

/** 描述截断：超长加省略号，避免整帧推送的值无限膨胀。 */
function clip(text, max) {
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
