/**
 * 技能轨迹 —— 浏览器半（Client plugin）。
 *
 * 纯 JS、无构建：DSH 的模块加载器要的就是
 * `window.__ModuleLoader__.load({ id, factory })`，`require('react')` 由页面自己的
 * 模块表提供（不会装第二份 React）。
 *
 * 右侧栏接入形状照抄已装机的 @nanmicoder/dsh-agent-teams（同一宿主版本的成熟
 * 先例），两步走：
 *
 *   sidebarRightTabs.register({ id, kind, title })      → 在右栏注册一个标签页
 *   slots.inject('sidebar.right.pane.tab', …register)   → 标签页的内容面板
 *
 * 面板条目的 `key` 与标签页的 `id` 必须一致 —— 这是"点标签打开这个面板"的唯一
 * 连接点。面板是会话作用域的 slot，标准工具包里自带 `useProjection`：技能轨迹
 * 的全部计算都在宿主投影单元里完成（key: `skill-trace`），这里只负责把推过来
 * 的整帧值渲染成时间线，不做任何领域折叠。
 *
 * 两种视图：
 *  - **轮次时间线**：一个轮次一张分镜卡；轮内"一次技能加载 = 一个阶段"，阶段
 *    之下的普通工具调用就是这个技能被遵循的"过程"，加载之前的是"前置调用"；
 *  - **技能目录**：会话当前发布的可调用技能清单（可折叠），来自目录消息。
 */
window.__ModuleLoader__.load({
    id: 'dsh-skill-tracer',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useEffect, useMemo, useRef, useState } = React;

        /** 词典命名空间。 */
        const NS = 'skill-tracer';
        /** 右栏标签页 id，同时也是 `sidebar.right.pane.tab` 槽的 key。 */
        const TAB_ID = 'dsh-skill-tracer/trace';
        /** 标签页 kind（右栏用它挑图标；自定义串走默认图标）。 */
        const TAB_KIND = 'skill-tracer';
        /** 宿主投影 key —— 与 lib/trace.js 的 PROJECTION_KEY 保持一致。 */
        const PROJECTION_KEY = 'skill-trace';
        /** 界面偏好（目录折叠状态）在浏览器里的键。 */
        const PREFS_KEY = 'dsh-skill-tracer.prefs.v1';

        const zh = {
            tab: '技能轨迹',
            title: '技能轨迹',
            subtitle: '技能调用的过程与逻辑：谁加载了技能、加载之后做了什么。',
            guideDesc: '查看技能调用的过程与逻辑',
            autoOpen: '自动打开',
            autoOpenHint: '有新的技能调用时自动展开右栏',
            live: '进行中',
            idle: '空闲',
            waiting: '正在等待宿主数据…',
            waitingHint: '面板依赖宿主的技能轨迹投影（sessionProjections）；若长时间无数据，请确认插件已在 profile 中启用。',
            empty: '这个会话还没有技能调用。',
            emptyHint: '当模型通过 skill 工具加载技能，或你用 /名称 显式调用技能时，这里会实时显示调用过程与后续的工具工作。',
            catalog: '技能目录',
            catalogEmpty: '当前会话没有已发布的可调用技能。',
            catalogHint: '技能目录由宿主在会话中发布；模型只应加载这里列出的技能。',
            turn: '轮次 {n}',
            turnPending: '轮次开始前',
            phaseBeforeSkill: '未加载技能（前置调用）',
            loadSkill: '加载技能',
            invokeSkill: '调用技能',
            byModel: '模型',
            byUser: '用户 /名称',
            toolCount: '{n} 次工具调用',
            toolOne: '1 次工具调用',
            noTools: '加载后没有工具调用',
            running: '运行中',
            ok: '完成',
            error: '失败',
            reasonCompleted: '已完成',
            reasonAborted: '已中断',
            reasonError: '出错',
            reasonCompacted: '已压缩',
            skillsLabel: '技能',
            turnsLabel: '轮次',
        };

        const en = {
            tab: 'Skill Trace',
            title: 'Skill Trace',
            subtitle: 'How skills were invoked: who loaded them and what followed.',
            guideDesc: 'See how skills were invoked and what followed',
            autoOpen: 'Auto-open',
            autoOpenHint: 'Expand the sidebar when a new skill invocation starts',
            live: 'Running',
            idle: 'Idle',
            waiting: 'Waiting for host data…',
            waitingHint: 'This panel relies on the host skill-trace projection (sessionProjections); if nothing arrives, make sure the plugin is enabled in the profile.',
            empty: 'No skill invocations in this session yet.',
            emptyHint: 'When the model loads a skill via the skill tool, or you invoke one with /name, the invocation and the tool work that follows appear here live.',
            catalog: 'Skill catalog',
            catalogEmpty: 'No invocable skills published in this session.',
            catalogHint: 'The catalog is published by the host; the model should only load skills listed here.',
            turn: 'Turn {n}',
            turnPending: 'Before the first turn',
            phaseBeforeSkill: 'No skill loaded (pre-call work)',
            loadSkill: 'Load skill',
            invokeSkill: 'Invoke skill',
            byModel: 'model',
            byUser: 'user /name',
            toolCount: '{n} tool calls',
            toolOne: '1 tool call',
            noTools: 'No tool calls after load',
            running: 'Running',
            ok: 'Done',
            error: 'Failed',
            reasonCompleted: 'Completed',
            reasonAborted: 'Interrupted',
            reasonError: 'Error',
            reasonCompacted: 'Compacted',
            skillsLabel: 'Skills',
            turnsLabel: 'Turns',
        };

        /** 读界面偏好；隐私模式或沙箱里没有 localStorage 时静默返回空对象。 */
        function readPrefs() {
            try {
                const raw = localStorage.getItem(PREFS_KEY);
                const parsed = raw === null ? null : JSON.parse(raw);
                return parsed !== null && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        }

        /** 合并写入界面偏好。 */
        function writePrefs(patch) {
            try {
                localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
            } catch {
                /* 存不下就算了，纯偏好 */
            }
        }

        /** 毫秒 → 简短时长（<1s 显毫秒，其余显一位小数的秒/分）。 */
        function duration(ms) {
            if (!Number.isFinite(ms) || ms < 0) return '';
            if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
            const seconds = ms / 1000;
            if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
            const minutes = Math.floor(seconds / 60);
            return `${minutes}m${Math.round(seconds % 60)}s`;
        }

        /** 时间戳 → `HH:MM:SS`。 */
        function clockTime(ms) {
            if (!Number.isFinite(ms)) return '';
            const date = new Date(ms);
            const pad = (value) => String(value).padStart(2, '0');
            return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        }

        /**
         * 把一个轮次的条目折叠成"阶段"：一次技能加载（或用户手势）开一个阶段，
         * 其后的普通工具调用归入该阶段；加载之前的归入 skill 为 null 的前置阶段。
         */
        function phaseify(items) {
            const phases = [];
            for (const item of items) {
                if (item.kind === 'skill' || item.kind === 'gesture') {
                    phases.push({ skill: item, tools: [] });
                    continue;
                }
                const last = phases.at(-1);
                if (last !== undefined) last.tools.push(item);
                else phases.push({ skill: null, tools: [item] });
            }
            return phases;
        }

        /** 状态点的配色与形状共用的小圆点。 */
        function StatusDot({ status }) {
            return h('span', { className: `dst-dot dst-dot-${status}`, 'aria-hidden': true });
        }

        /** 一次技能加载（模型 / 用户手势）的阶段头节点。 */
        function SkillNode({ phase, now, t }) {
            const skill = phase.skill;
            const isGesture = skill.kind === 'gesture';
            const label = isGesture ? t('invokeSkill') : t('loadSkill');
            const via = isGesture ? t('byUser') : t('byModel');
            const stateLabel = skill.status === 'running' ? t('running') : skill.status === 'error' ? t('error') : t('ok');
            const span = skill.endedAt !== null ? duration(skill.endedAt - skill.startedAt) : duration(now - skill.startedAt);
            return h('div', { className: 'dst-skill' },
                h('div', { className: 'dst-skill-head' },
                    h(StatusDot, { status: skill.status }),
                    h('span', { className: 'dst-skill-label' }, label),
                    h('span', { className: 'dst-skill-name', title: skill.skillName ?? '' }, skill.skillName ?? '?'),
                    h('span', { className: 'dst-via' }, via)),
                h('div', { className: 'dst-skill-sub' },
                    h('span', { className: `dst-state dst-state-${skill.status}` }, stateLabel),
                    span !== '' ? h('span', { className: 'dst-dim' }, span) : null,
                    skill.errorCode !== undefined ? h('span', { className: 'dst-errcode' }, skill.errorCode) : null,
                    phase.tools.length > 0
                        ? h('span', { className: 'dst-dim' }, (phase.tools.length === 1 ? t('toolOne') : t('toolCount')).replace('{n}', String(phase.tools.length)))
                        : h('span', { className: 'dst-dim' }, t('noTools'))));
        }

        /** 阶段内一行普通工具调用。 */
        function ToolRow({ item, now, t }) {
            const stateLabel = item.status === 'running' ? t('running') : item.status === 'error' ? t('error') : t('ok');
            const span = item.endedAt !== null ? duration(item.endedAt - item.startedAt) : duration(now - item.startedAt);
            return h('div', { className: 'dst-tool', title: item.callId },
                h(StatusDot, { status: item.status }),
                h('span', { className: 'dst-tool-name' }, item.toolName),
                h('span', { className: `dst-state dst-state-${item.status}` }, stateLabel),
                h('span', { className: 'dst-dim' }, span),
                item.errorCode !== undefined ? h('span', { className: 'dst-errcode' }, item.errorCode) : null);
        }

        /** 一个阶段：技能节点 + 它之下的工具调用（或前置调用组）。 */
        function Phase({ phase, now, t }) {
            return h('div', { className: 'dst-phase' },
                phase.skill !== null
                    ? h(SkillNode, { phase, now, t })
                    : h('div', { className: 'dst-pre' }, h('span', { className: 'dst-dim' }, t('phaseBeforeSkill'))),
                h('div', { className: 'dst-tools' },
                    phase.tools.map((item) => h(ToolRow, { key: item.callId, item, now, t }))));
        }

        /** 一张轮次分镜卡。 */
        function TurnCard({ turn, now, t }) {
            const phases = useMemo(() => phaseify(turn.items), [turn.items]);
            const hasRunning = turn.items.some((item) => item.status === 'running');
            const reasonKey = turn.endReason === undefined ? null
                : turn.endReason === 'completed' ? 'reasonCompleted'
                    : turn.endReason === 'aborted' ? 'reasonAborted'
                        : turn.endReason === 'compacted' ? 'reasonCompacted' : null;
            return h('div', { className: `dst-turn${hasRunning ? ' dst-turn-live' : ''}` },
                h('div', { className: 'dst-turn-head' },
                    h('span', { className: 'dst-turn-name' }, (turn.pending === true ? t('turnPending') : t('turn').replace('{n}', String(turn.turn)))),
                    h('span', { className: 'dst-dim' }, `${clockTime(turn.startedAt)}${turn.endedAt !== null ? ` – ${clockTime(turn.endedAt)}` : ''}`),
                    hasRunning ? h('span', { className: 'dst-live-chip' }, t('live'))
                        : reasonKey !== null ? h('span', { className: 'dst-dim' }, t(reasonKey)) : null),
                turn.items.length === 0
                    ? h('div', { className: 'dst-dim', style: { padding: '4px 0 2px' } }, '—')
                    : phases.map((phase, index) => h(Phase, { key: index, phase, now, t })));
        }

        /** 会话当前发布的技能目录（可折叠）。 */
        function CatalogCard({ catalog, t }) {
            const [open, setOpen] = useState(() => readPrefs().catalogOpen === true);
            const toggle = () => {
                setOpen(!open);
                writePrefs({ catalogOpen: !open });
            };
            return h('div', { className: 'dst-catalog' },
                h('button', { type: 'button', className: 'dst-catalog-head', onClick: toggle, 'aria-expanded': String(open) },
                    h('span', { className: `dst-caret${open ? ' dst-caret-open' : ''}`, 'aria-hidden': true }, '▸'),
                    h('span', { className: 'dst-catalog-title' }, t('catalog')),
                    h('span', { className: 'dst-dim' }, String(catalog.length))),
                open ? h('div', { className: 'dst-catalog-body' },
                    catalog.length === 0
                        ? h('div', { className: 'dst-dim' }, t('catalogEmpty'))
                        : catalog.map((entry) => h('div', { key: entry.name, className: 'dst-catalog-entry' },
                            h('span', { className: 'dst-skill-name' }, entry.name),
                            entry.description !== '' ? h('span', { className: 'dst-catalog-desc' }, entry.description) : null)),
                    h('div', { className: 'dst-catalog-hint' }, t('catalogHint')))
                    : null);
        }

        /** 轨迹里的技能调用总数（模型加载 + 用户手势；普通工具调用不算）。 */
        function invocationCount(trace) {
            if (trace === undefined || trace === null || !Array.isArray(trace.turns)) return 0;
            return trace.turns.reduce((count, turn) => count + (Array.isArray(turn.items)
                ? turn.items.filter((item) => item.kind === 'skill' || item.kind === 'gesture').length
                : 0), 0);
        }

        /** 条目图标（右栏引导页胶囊与头部按钮共用）；`currentColor` 描边。 */
        function TraceGlyph({ size = 16, className }) {
            return h('svg', {
                width: size,
                height: size,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                className,
                'aria-hidden': true,
            },
                h('path', { d: 'M4 5.5h7a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H8a3 3 0 0 0-3 3v0a3 3 0 0 0 3 3h8' }),
                h('circle', { cx: 4, cy: 5.5, r: 1.6 }),
                h('circle', { cx: 19, cy: 17.5, r: 1.6 }),
                h('path', { d: 'M14.5 15.5l2 2-2 2', strokeWidth: 1.4 }));
        }

        /** 展开右栏到本插件标签页；命令失败（无屏幕会话等）静默降级。 */
        function openTraceTab(sidebar) {
            if (sidebar === undefined) return;
            try {
                sidebar.openTab(TAB_KIND);
            } catch {
                /* 未注册的 kind 或无屏幕会话时 openTab 会 throw —— 那是接线错误，吞掉即可 */
            }
        }

        /**
         * 会话头部的"技能轨迹"按钮，同时承担自动打开：
         * 这个槽是会话作用域、随会话常驻渲染 —— `useProjection` 在这里始终可用，
         * 技能调用数一涨就替用户展开右栏（可在面板里关掉）。
         */
        function TraceEntry({ sessionId, useProjection, sidebar, t }) {
            const count = typeof useProjection === 'function' ? invocationCount(useProjection(PROJECTION_KEY)) : 0;
            const seenRef = useRef(null);
            const lastSessionRef = useRef(undefined);
            useEffect(() => {
                // 会话切换时重置基线：回到一个"已有历史"的会话不算新调用。
                const previous = lastSessionRef.current === sessionId ? seenRef.current : null;
                lastSessionRef.current = sessionId;
                seenRef.current = count;
                if (previous === null || count <= previous) return;
                if (readPrefs().autoOpen === false) return;
                if (sidebar === undefined || sessionId === undefined) return;
                try {
                    if (sidebar.mounted.getSnapshot() !== sessionId) return;
                    if (sidebar.isExpanded()) return;
                    openTraceTab(sidebar);
                } catch {
                    /* mounted/isExpanded 的可观察值不可用时放弃本次自动打开 */
                }
            }, [count, sessionId, sidebar]);
            return h('button', {
                type: 'button',
                className: 'dst-entry',
                title: t('guideDesc'),
                onClick: () => openTraceTab(sidebar),
            },
                h(TraceGlyph, { size: 14 }),
                h('span', null, t('tab')));
        }

        /** 右栏标签页面板：宿主投影值的唯一渲染方。 */
        function TracePane(props) {
            const t = typeof props?.t === 'function' ? props.t : fallbackT();
            const useProjection = props?.useProjection;
            const bodyRef = useRef(null);
            const [now, setNow] = useState(() => Date.now());

            // 标准工具包按会话作用域装配；拿不到 useProjection 说明宿主版本
            // 太老或槽位作用域变了 —— 明说，别让用户对着白屏猜。
            if (typeof useProjection !== 'function') {
                return h('div', { className: 'dst-root' },
                    h('style', null, CSS),
                    h('div', { className: 'dst-empty' },
                        h('div', null, t('waiting')),
                        h('div', { className: 'dst-sub' }, t('waitingHint'))));
            }

            const trace = useProjection(PROJECTION_KEY);

            const hasRunning = trace !== undefined
                && trace.turns.some((turn) => turn.items.some((item) => item.status === 'running'));
            // 有运行中的调用时每秒走一针，运行时长才会动；空闲时不留定时器。
            useEffect(() => {
                if (!hasRunning) return undefined;
                const timer = setInterval(() => setNow(Date.now()), 1000);
                return () => clearInterval(timer);
            }, [hasRunning]);

            // 时间线按阅读顺序（旧 → 新）；只要用户就在底部附近，新事件一到
            // 就跟着滚到底，像聊天一样"看过程"。
            useEffect(() => {
                const node = bodyRef.current;
                if (node === null) return;
                const nearBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 96;
                if (nearBottom) node.scrollTop = node.scrollHeight;
            }, [trace]);

            if (trace === undefined) {
                return h('div', { className: 'dst-root' },
                    h('style', null, CSS),
                    h('div', { className: 'dst-empty' },
                        h('div', null, t('waiting')),
                        h('div', { className: 'dst-sub' }, t('waitingHint'))));
            }

            const turns = trace.turns ?? [];
            const catalog = Array.isArray(trace.catalog) ? trace.catalog : [];
            const activeSkillCount = turns.reduce((count, turn) => count + turn.items.filter((item) => item.kind !== 'tool').length, 0);

            return h('div', { className: 'dst-root' },
                h('style', null, CSS),
                h('div', { className: 'dst-head' },
                    h('div', { className: 'dst-title-row' },
                        h('span', { className: 'dst-title' }, t('title')),
                        h('span', { className: `dst-live-chip${hasRunning ? '' : ' dst-live-idle'}` }, hasRunning ? t('live') : t('idle'))),
                    h('div', { className: 'dst-sub' }, t('subtitle')),
                    h('div', { className: 'dst-meta' },
                        h('span', { className: 'dst-dim' }, `${t('skillsLabel')} ${activeSkillCount}`),
                        h('span', { className: 'dst-dim' }, `${t('turnsLabel')} ${turns.length}`),
                        h('button', {
                            type: 'button',
                            className: 'dst-toggle',
                            title: t('autoOpenHint'),
                            'data-on': String(readPrefs().autoOpen !== false),
                            onClick: (event) => {
                                const next = readPrefs().autoOpen === false;
                                writePrefs({ autoOpen: next });
                                event.currentTarget.dataset.on = String(next);
                            },
                        }, `${t('autoOpen')} ${readPrefs().autoOpen === false ? '·' : '✓'}`))),
                h('div', { className: 'dst-body', ref: bodyRef },
                    turns.length === 0 && catalog.length === 0
                        ? h('div', { className: 'dst-empty' },
                            h('div', null, t('empty')),
                            h('div', { className: 'dst-sub' }, t('emptyHint')))
                        : null,
                    catalog.length > 0 || trace.catalogAt !== null
                        ? h(CatalogCard, { catalog, t })
                        : null,
                    turns.map((turn) => h(TurnCard, { key: `${turn.pending === true ? 'p' : ''}${turn.turn}-${turn.startedAt}`, turn, now, t }))));
        }

        /** 本地翻译函数：按页面语言在 zh / en 之间二选一（拿不到宿主 translator 时的兜底）。 */
        function fallbackT() {
            const language = `${document.documentElement.lang || navigator.language || 'en'}`.toLowerCase();
            const dict = language.startsWith('zh') ? zh : en;
            return (key) => dict[key] ?? en[key] ?? key;
        }

        /**
         * 面板样式。
         *
         * 只引用 `--dsw-alias-*` token（都带 fallback），浅色/深色主题自动跟随；
         * 类名统一带 `dst-` 前缀，避免和宿主页面撞名。
         */
        const CSS = `
.dst-root{display:flex;flex-direction:column;height:100%;min-height:320px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,inherit);font-size:13px}
.dst-head{display:flex;flex-direction:column;gap:6px;padding:12px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.dst-title-row{display:flex;align-items:center;gap:8px}
.dst-title{font-size:14px;font-weight:600}
.dst-sub{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
.dst-meta{display:flex;gap:10px;align-items:center}
.dst-meta .dst-dim{font-size:12px}
.dst-toggle{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4a4f57);border-radius:999px;padding:1px 8px;font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.dst-toggle[data-on="true"]{color:var(--dsw-alias-brand-primary,#1f6feb);border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dst-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dst-entry{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4a4f57);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dst-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#0f1115)}
.dst-live-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#4a4f57)}
.dst-live-chip:not(.dst-live-idle){background:var(--dsw-alias-brand-primary,#1f6feb);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dst-body{flex:1;min-height:0;overflow:auto;padding:10px 14px 16px;display:flex;flex-direction:column;gap:10px}
.dst-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;text-align:center;padding:40px 16px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dst-empty .dst-sub{max-width:420px}
.dst-catalog{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff)}
.dst-catalog-head{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;border:none;background:transparent;color:inherit;font:inherit;padding:8px 10px;cursor:pointer;text-align:left}
.dst-catalog-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dst-caret{display:inline-block;transition:transform .12s ease;color:var(--dsw-alias-label-tertiary,#81858c)}
.dst-caret-open{transform:rotate(90deg)}
.dst-catalog-title{font-weight:600}
.dst-catalog-body{display:flex;flex-direction:column;gap:6px;padding:2px 10px 10px}
.dst-catalog-entry{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-sm,6px)}
.dst-catalog-desc{color:var(--dsw-alias-label-secondary,#4a4f57);font-size:12px}
.dst-catalog-hint{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.dst-turn{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.dst-turn-live{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dst-turn-head{display:flex;align-items:center;gap:8px}
.dst-turn-name{font-weight:600}
.dst-phase{display:flex;flex-direction:column;gap:4px}
.dst-skill{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-left:3px solid var(--dsw-alias-brand-primary,#1f6feb);border-radius:var(--dsw-radius-sm,6px);padding:7px 9px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}
.dst-skill-head{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.dst-skill-label{color:var(--dsw-alias-label-secondary,#4a4f57)}
.dst-skill-name{font-family:var(--dsw-font-markdown-code,ui-monospace,monospace);font-size:12px;word-break:break-all}
.dst-via{margin-left:auto;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;padding:0 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#4a4f57);white-space:nowrap}
.dst-skill-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dst-pre{padding:2px 0}
.dst-tools{display:flex;flex-direction:column;gap:2px;padding-left:14px;border-left:2px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin-left:5px}
.dst-tool{display:flex;align-items:center;gap:7px;min-width:0;padding:2px 4px;border-radius:var(--dsw-radius-sm,6px)}
.dst-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dst-tool-name{font-family:var(--dsw-font-markdown-code,ui-monospace,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dst-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#81858c)}
.dst-dot-running{background:var(--dsw-alias-brand-primary,#1f6feb);animation:dst-pulse 1.1s ease-in-out infinite}
.dst-dot-ok{background:var(--dsw-alias-state-success-primary,#1a7f37)}
.dst-dot-error{background:var(--dsw-alias-state-error-primary,#d93025)}
@keyframes dst-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dst-dot-running{animation:none}}
.dst-state{font-size:11px}
.dst-state-running{color:var(--dsw-alias-brand-primary,#1f6feb)}
.dst-state-ok{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.dst-state-error{color:var(--dsw-alias-state-error-primary,#d93025)}
.dst-dim{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
.dst-errcode{font-family:var(--dsw-font-markdown-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-state-error-primary,#d93025)}
`;

        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skill-tracer: dictionaries');
            // 右栏服务是 0.2.x 组合才有的可选能力：缺席时这里整体保持沉默，
            // 面板与标签页都不出现，而不是 pending 在一个不存在的 key 上。
            ctx.inject(['sidebarRight', 'sidebarRightTabs'], (native) => {
                const t = native.locale.bind(NS);
                native.effect(() => native.sidebarRightTabs.register({
                    id: TAB_ID,
                    kind: TAB_KIND,
                    title: () => t('tab'),
                    // 引导页入口：右栏的标签系统是"编辑器式"的 —— 只注册类型
                    // 不会产生任何可见入口；引导页罗盘下的胶囊才是用户摸得到
                    // 的门。没有它，本类型在右栏里就完全不可见。
                    guide: [{
                        id: 'trace',
                        title: () => t('tab'),
                        description: () => t('guideDesc'),
                        order: 80,
                        icon: TraceGlyph,
                    }],
                }));
                // 标签页内容面板：`key` 与标签页 id 一致；会话作用域的标准工具包
                // 会递进 sessionId / useProjection / t。
                native.slots.inject('sidebar.right.pane.tab', () => native.slots.register({
                    name: 'sidebar.right.pane.tab',
                    key: TAB_ID,
                    locale: NS,
                }, TracePane));
                // 会话头部的常驻入口：一键打开轨迹页，并承担"有新技能调用时
                // 自动展开右栏"的监视（槽是会话作用域，useProjection 常在）。
                native.slots.inject('conversation.session.header.actions', () => native.slots.register({
                    name: 'conversation.session.header.actions',
                    id: 'skill-tracer-entry',
                    order: 60,
                    locale: NS,
                    inject: () => ({ sidebar: native.sidebarRight }),
                }, TraceEntry));
            });
        }

        return {
            name: 'skill-tracer-client',
            inject: ['slots', 'locale'],
            apply,
        };
    },
});
