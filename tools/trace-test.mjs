/**
 * 折叠逻辑离线自测：喂一段脚本化的会话事件序列，断言投影状态。
 *
 * 事件形状逐字段对齐真实 v4 会话日志（见 lib/trace.js 头注）。运行：
 *
 *   node tools/trace-test.mjs
 */
import assert from 'node:assert/strict';
import { Config, resolveConfig } from '../lib/config.js';
import {
    PROJECTION_KEY,
    STATE_VERSION,
    initialState,
    createFold,
    stateSchema,
    viewSchema,
} from '../lib/trace.js';

const bounds = resolveConfig({});
assert.deepEqual(bounds, { maxTurns: 8, maxItems: 120, catalogDescriptionMax: 200 }, 'defaults resolve');
assert.equal(PROJECTION_KEY, 'skill-trace');
assert.equal(STATE_VERSION, 1);

const fold = createFold(bounds);
let state = initialState();
const seen = (event) => { state = fold(state, event); };

const event = (type, seq, data, time = 1_700_000_000_000 + seq * 1000) => ({ type, seq, time, data });

// --- 1. 目录发布（含一条会话） ---
seen(event('user/message', 10, {
    content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n- `pdf:pdf`: Professional PDF toolkit. Handle reports.\n- `design-taste`: 前端审美\n</available_skills>\n</system-reminder>' }],
    source: { kind: 'skill-catalog' },
}));
assert.equal(state.catalog.length, 2, 'catalog parsed');
assert.equal(state.catalog[0].name, 'pdf:pdf');
assert.equal(state.catalog[0].description, 'Professional PDF toolkit. Handle reports.');
assert.equal(state.catalogAt, 10);
assert.deepEqual(stateSchema.parse(state), state, 'state passes schema after catalog');

// --- 2. 空目录替换停用旧名称 ---
seen(event('user/message', 12, {
    content: [{ type: 'text', text: '<system-reminder>\nNo skills are currently available through the `skill` tool.\n</system-reminder>' }],
    source: { kind: 'skill-catalog' },
}));
assert.deepEqual(state.catalog, [], 'empty catalog replaces');
assert.equal(state.catalogAt, 12);

// --- 3. 目录再发布 + 轮次开始 ---
seen(event('user/message', 14, {
    content: [{ type: 'text', text: '<available_skills>\n- `pdf:pdf`: PDF toolkit\n</available_skills>' }],
    source: { kind: 'skill-catalog' },
}));
seen(event('turn/start', 20, { turn: 1 }));
assert.equal(state.activeTurn, 1);
assert.equal(state.turns.length, 1);

// --- 4. 模型经 skill 工具加载：running → ok ---
seen(event('tool/call', 22, { turn: 1, step: 1, callId: 'call_a', name: 'skill', arguments: '{"name": "pdf:pdf"}' }));
const loadItem = state.turns[0].items.at(-1);
assert.equal(loadItem.kind, 'skill');
assert.equal(loadItem.skillName, 'pdf:pdf');
assert.equal(loadItem.via, 'model');
assert.equal(loadItem.status, 'running');

// --- 5. 加载之后的普通工具调用（阶段内过程） ---
seen(event('tool/call', 24, { turn: 1, step: 2, callId: 'call_b', name: 'read', arguments: '{"path": "/x"}' }));
seen(event('tool/call', 26, { turn: 1, step: 2, callId: 'call_c', name: 'bash', arguments: '{"command": "ls"}' }));
seen(event('tool/result', 25, { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call_a' }, content: [{ type: 'text', text: '<skill_content name="pdf:pdf">…' }], isError: false } }));
assert.equal(state.turns[0].items.find((item) => item.callId === 'call_a').status, 'ok', 'skill load closes ok');

// 结果乱序到达（并行调用）：call_c 的结果先于 call_b
seen(event('tool/result', 28, { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'call_c' }, content: [], isError: false } }));
seen(event('tool/result', 29, { turn: 1, step: 2, message: { role: 'tool', source: { kind: 'tool', callId: 'call_b' }, isError: true }, error: { name: 'X', code: 'TOOL_FAILED' } }));
const tools = state.turns[0].items.filter((item) => item.kind === 'tool');
assert.equal(tools.length, 2);
assert.equal(tools.find((item) => item.callId === 'call_c').status, 'ok');
assert.equal(tools.find((item) => item.callId === 'call_b').status, 'error');
assert.equal(tools.find((item) => item.callId === 'call_b').errorCode, 'TOOL_FAILED');

// --- 6. 轮次闭合 ---
seen(event('turn/end', 40, { turn: 1, reason: { kind: 'completed' } }));
assert.equal(state.activeTurn, null);
assert.equal(state.turns[0].endedAt !== null, true);
assert.equal(state.turns[0].endReason, 'completed');

// --- 7. 用户 /名称 手势（注入落成 user/message） ---
seen(event('turn/start', 50, { turn: 2 }));
seen(event('user/message', 52, {
    content: [{ type: 'text', text: '<skill_content name="pdf:pdf">…</skill_content>' }],
    source: { kind: 'skill-invocation', name: 'pdf:pdf', form: 'instructions' },
}));
const gestureTurn = state.turns.find((turn) => turn.turn === 2);
const gesture = gestureTurn.items.at(-1);
assert.equal(gesture.kind, 'gesture');
assert.equal(gesture.skillName, 'pdf:pdf');
assert.equal(gesture.via, 'user');
assert.equal(gesture.status, 'ok');

// --- 8. 轮次外的普通用户消息不产生任何变化（同引用即无工作） ---
const before = state;
seen(event('user/message', 54, { content: [{ type: 'text', text: '生成一张图' }], source: { kind: 'user', rpcId: 'r1' } }));
assert.equal(state, before, 'unrelated event keeps reference');
seen(event('step/start', 55, { turn: 2, step: 1 }));
assert.equal(state, before, 'step events ignored');
seen(event('assistant/message', 56, { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }));
assert.equal(state, before, 'assistant messages ignored');

// --- 9. 中断的轮次：无结果的调用保持 running，轮次仍闭合 ---
seen(event('tool/call', 58, { turn: 2, step: 1, callId: 'call_d', name: 'skill', arguments: 'not-json-but-name-in-it "name": "pdf:pdf"' }));
const interrupted = state.turns.find((turn) => turn.turn === 2).items.at(-1);
assert.equal(interrupted.skillName, 'pdf:pdf', 'regex fallback parses name');
seen(event('turn/end', 60, { turn: 2, reason: { kind: 'aborted' } }));
assert.equal(state.turns.find((turn) => turn.turn === 2).items.find((item) => item.callId === 'call_d').status, 'running', 'no result → stays running');

// --- 10. 合成轮次：早于任何 turn/start 的手势 ---
let fresh = initialState();
const foldFresh = createFold(bounds);
fresh = foldFresh(fresh, event('user/message', 5, { content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-invocation', name: 'a' } }));
assert.equal(fresh.turns.length, 1);
assert.equal(fresh.turns[0].pending, true);
fresh = foldFresh(fresh, event('user/message', 6, { content: [{ type: 'text', text: 'y' }], source: { kind: 'skill-invocation', name: 'b' } }));
assert.equal(fresh.turns.length, 1, 'pending turn merges');
assert.equal(fresh.turns[0].items.length, 2);
// turn/start 之后归入真实轮次
fresh = foldFresh(fresh, event('turn/start', 7, { turn: 1 }));
fresh = foldFresh(fresh, event('user/message', 8, { content: [{ type: 'text', text: 'z' }], source: { kind: 'skill-invocation', name: 'c' } }));
assert.equal(fresh.turns.find((turn) => turn.turn === 1).items.length, 1);
assert.deepEqual(viewSchema.parse(fresh), fresh, 'view schema accepts state');

// --- 11. 裁剪上限（maxItems 的配置下限是 10，这里用 10 / 每轮 14 条调用） ---
const tiny = resolveConfig({ maxTurns: 2, maxItems: 10 });
const foldTiny = createFold(tiny);
let clipped = initialState();
for (let turn = 1; turn <= 4; turn += 1) {
    clipped = foldTiny(clipped, event('turn/start', turn * 10, { turn }));
    for (let step = 0; step < 14; step += 1) {
        clipped = foldTiny(clipped, event('tool/call', turn * 10 + step, { turn, step, callId: `c${turn}_${step}`, name: 'bash', arguments: '{}' }));
    }
}
assert.equal(clipped.turns.length, 2, 'turn cap');
assert.deepEqual(clipped.turns.map((turn) => turn.turn), [3, 4], 'keeps newest turns');
assert.ok(clipped.turns.every((turn) => turn.items.length <= 10), 'item cap');
assert.deepEqual(stateSchema.parse(clipped), clipped, 'clipped state passes schema');

// --- 12. view = state，wire 值可直接 parse ---
assert.equal(stateSchema, viewSchema);

console.log('trace-test: all assertions passed');
