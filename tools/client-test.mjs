/**
 * 客户端半冒烟测试：模拟 `window.__ModuleLoader__` 与页面模块表，验证
 *  - factory 可加载、导出形状正确（name / inject / apply）；
 *  - apply 注册词典，并在右栏服务出现时注册标签页与 `sidebar.right.pane.tab` 面板，
 *    标签页 id 与面板 key 一致；
 *  - TracePane 能把投影值渲染成静态标记（react-dom/server，无 DOM）。
 *
 * 运行：node tools/client-test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * react 与 react-dom 必须是同一份实例（跨实例的 React 元素不能互渲染）。
 * 桌面宿主（0.2.x）用 React 19；这里从 npm 安装的 dsh 树里取一对匹配的
 * react / react-dom/server。真实运行时不走这条路径：client.js 的 require
 * 由页面模块表供料，永远是宿主自己的那一份。
 */
const hostDshRequire = createRequire('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/'
    + 'node_modules/@deepseek-ai/dsh-client-ui-trajectory/package.json');
const React = hostDshRequire('react');
const h = React.createElement;
const { renderToStaticMarkup } = hostDshRequire('react-dom/server');

// --- 模块表 + 模块加载器桩 ---
const modules = new Map([
    ['react', React],
    ['react/jsx-runtime', hostDshRequire('react/jsx-runtime')],
]);

let loaded = null;
globalThis.window = {
    __ModuleLoader__: {
        load(definition) {
            loaded = definition;
        },
    },
};
globalThis.document = { documentElement: { lang: 'zh' } };
// Node 24 的 globalThis.navigator 只有 getter，得用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

await import('../client.js');
assert.notEqual(loaded, null, 'client module registered itself');
assert.equal(loaded.id, 'dsh-skill-tracer');

const plugin = loaded.factory((name) => {
    const mod = modules.get(name);
    if (mod === undefined) throw new Error(`module not stubbed: ${name}`);
    return mod;
});
assert.equal(plugin.name, 'skill-tracer-client');
assert.deepEqual(plugin.inject, ['slots', 'locale']);
assert.equal(typeof plugin.apply, 'function');

// --- 宿主客户端上下文桩 ---
const effects = [];
const dictionaries = new Map();
const registeredTabs = [];
const slotInjections = [];
const slotRegistrations = [];
const openedTabs = [];

const sidebarRightStub = {
    openTab(kind) {
        openedTabs.push(kind);
    },
    isExpanded: () => false,
    mounted: { getSnapshot: () => 'session-test' },
};

const ctx = {
    effect(factory, label) {
        effects.push({ factory, label });
        return factory();
    },
    locale: {
        register(ns, dict) {
            dictionaries.set(ns, dict);
        },
        bind(ns) {
            const dict = dictionaries.get(ns);
            return (key) => dict?.zh?.[key] ?? key;
        },
    },
    inject(serviceKeys, callback) {
        assert.deepEqual(serviceKeys, ['sidebarRight', 'sidebarRightTabs'], 'right-sidebar services requested');
        const native = {
            effect(factory) {
                return factory();
            },
            locale: ctx.locale,
            sidebarRight: sidebarRightStub,
            sidebarRightTabs: {
                register(tab) {
                    registeredTabs.push(tab);
                    return () => undefined;
                },
            },
            slots: {
                inject(slotName, factory) {
                    slotInjections.push(slotName);
                    factory();
                },
                register(options, component) {
                    slotRegistrations.push({ options, component });
                    return () => undefined;
                },
            },
        };
        callback(native);
    },
};

plugin.apply(ctx);
const dict = dictionaries.get('skill-tracer');
assert.notEqual(dict, undefined, 'locale dictionary registered');
assert.equal(dict.zh.tab, '技能轨迹');
assert.equal(dict.en.tab, 'Skill Trace');

assert.equal(registeredTabs.length, 1, 'one right-sidebar tab registered');
assert.equal(registeredTabs[0].id, 'dsh-skill-tracer/trace');
assert.equal(registeredTabs[0].kind, 'skill-tracer');
assert.equal(registeredTabs[0].title(), '技能轨迹');

// 引导页入口：右栏是"编辑器式"标签系统，没有 guide 条目用户就没有可见入口。
const guideEntries = registeredTabs[0].guide ?? [];
assert.equal(guideEntries.length, 1, 'guide entry contributed');
assert.equal(guideEntries[0].id, 'trace');
assert.equal(guideEntries[0].title(), '技能轨迹');
assert.equal(guideEntries[0].description(), '查看技能调用的过程与逻辑');
assert.equal(typeof guideEntries[0].icon, 'function');

assert.deepEqual(slotInjections, ['sidebar.right.pane.tab', 'conversation.session.header.actions'],
    'pane installed via the right-pane slot; entry button in the session header');
assert.equal(slotRegistrations.length, 2);
const paneRegistration = slotRegistrations.find((r) => r.options.name === 'sidebar.right.pane.tab');
const entryRegistration = slotRegistrations.find((r) => r.options.name === 'conversation.session.header.actions');
assert.notEqual(paneRegistration, undefined);
assert.equal(paneRegistration.options.key, registeredTabs[0].id, 'pane key === tab id');
assert.notEqual(entryRegistration, undefined);
assert.equal(entryRegistration.options.inject().sidebar, sidebarRightStub, 'entry button receives the sidebar controller');

// --- 面板渲染：合成一份投影值 ---
const { component } = paneRegistration;
const syntheticTrace = {
    catalog: [{ name: 'pdf:pdf', description: 'PDF 工具箱' }],
    catalogAt: 10,
    activeTurn: 2,
    turns: [
        {
            turn: 1,
            startedAt: 1_760_000_000_000,
            endedAt: 1_760_000_060_000,
            endReason: 'completed',
            items: [
                { kind: 'skill', callId: 'call_a', toolName: 'skill', skillName: 'pdf:pdf', via: 'model', status: 'ok', startedAt: 1_760_000_000_500, endedAt: 1_760_000_001_500 },
                { kind: 'tool', callId: 'call_b', toolName: 'read', status: 'ok', startedAt: 1_760_000_002_000, endedAt: 1_760_000_002_800 },
                { kind: 'tool', callId: 'call_c', toolName: 'bash', status: 'error', startedAt: 1_760_000_003_000, endedAt: 1_760_000_003_900, errorCode: 'TOOL_FAILED' },
            ],
        },
        {
            turn: 2,
            startedAt: 1_760_000_100_000,
            endedAt: null,
            items: [
                { kind: 'gesture', callId: 'gesture:52', toolName: '', skillName: 'pdf:pdf', via: 'user', status: 'ok', startedAt: 1_760_000_101_000, endedAt: 1_760_000_101_000 },
                { kind: 'tool', callId: 'call_d', toolName: 'write', status: 'running', startedAt: 1_760_000_102_000, endedAt: null },
            ],
        },
    ],
};

const pane = h(component, {
    sessionId: 'session-test',
    t: (key) => dict.zh[key] ?? key,
    useProjection: (key) => {
        assert.equal(key, 'skill-trace', 'pane reads the skill-trace projection');
        return syntheticTrace;
    },
});
const markup = renderToStaticMarkup(pane);
for (const expected of ['技能轨迹', '技能目录', 'pdf:pdf', '轮次 1', '轮次 2', '加载技能', '调用技能', 'read', 'bash', '运行中', 'TOOL_FAILED', '已完成']) {
    assert.ok(markup.includes(expected), `markup contains ${JSON.stringify(expected)}`);
}

// --- 能力缺席降级：undefined 投影 → 等待提示，而不是白屏或抛错 ---
const waitingPane = h(component, {
    sessionId: 'session-test',
    t: (key) => dict.zh[key] ?? key,
    useProjection: () => undefined,
});
const waitingMarkup = renderToStaticMarkup(waitingPane);
assert.ok(waitingMarkup.includes('正在等待宿主数据'), 'undefined projection renders waiting hint');

// --- 完全没有 useProjection 的老宿主 → 同样降级 ---
const legacyPane = h(component, { sessionId: 'session-test', t: (key) => dict.zh[key] ?? key });
assert.ok(renderToStaticMarkup(legacyPane).includes('正在等待宿主数据'), 'missing useProjection degrades gracefully');

// --- 头部入口按钮：渲染出带标签的按钮 ---
const entryComponent = entryRegistration.component;
const entryProps = { sessionId: 'session-test', t: (key) => dict.zh[key] ?? key, sidebar: sidebarRightStub, useProjection: () => syntheticTrace };
const entryMarkup = renderToStaticMarkup(h(entryComponent, entryProps));
assert.ok(entryMarkup.includes('技能轨迹'), 'entry button renders with label');
assert.ok(entryMarkup.includes('<button'), 'entry button is a real button');

console.log('client-test: all assertions passed');
