# dsh-skill-tracer

DeepSeek Harness 插件：**把技能调用的过程与逻辑可视化，渲染在官方右侧栏**。

当模型通过 `skill` 工具加载技能、或你用 `/名称` 显式调用技能时，右侧栏的
"技能轨迹"面板会实时显示：

- **技能目录**：会话当前发布的可调用技能清单（名称 + 描述）；
- **谁加载了技能**：模型自主加载 / 用户 `/名称` 手势，含状态（运行中/完成/失败）、
  时长与错误码；
- **加载之后做了什么**：同一轮次里跟随的每一次工具调用 —— 一次技能加载开启一个
  "阶段"，阶段之下的工具调用就是这个技能被遵循的过程；加载之前的是"前置调用"；
- **轮次分镜**：以轮次（turn）为单位组织，进行中的轮次高亮并显示实时时长。

## 三个入口

右栏的标签系统是"编辑器式"的：注册标签类型本身不产生任何可见入口，三个门都
由本插件显式搭好——

1. **会话头部按钮**：聊天输入区上方的会话头部里，"技能轨迹"胶囊按钮，一键打开；
2. **引导页胶囊**：点右栏展开按钮 → 引导页（罗盘）→ "技能轨迹"入口卡；
3. **自动打开**（默认开）：有新的技能调用且右栏收起时，自动展开到轨迹页；
   面板头部有开关（记在浏览器 localStorage）。

注意：`/tracer` 这类输入是**技能手势**语法（`/技能名`），不是本插件的命令——
本插件不注册 slash 命令，轨迹页随会话自动更新，无需命令触发。

## 工作原理

```
会话日志（唯一真源）
  tool/call · tool/result · user/message · turn/*
        │  纯函数折叠（lib/trace.js）
        ▼
sessionProjections 单元 "skill-trace"      ← host 半（index.js）
        │  api-proxy：session/projection 帧（整帧推送，客户端零折叠）
        ▼
右侧栏 "技能轨迹" 标签页                    ← client 半（client.js）
  sidebarRightTabs + sidebar.right.pane.tab（接入形状与 @nanmicoder/dsh-agent-teams 一致）
```

- 投影状态只从**既有事件类型**派生，不追加任何自定义事件类型（未带 `ignorable`
  的新类型会让会话拒绝重开），对模型零可见、对 KV Cache 零影响；
- 状态是纯 JSON 且有裁剪上限（`maxTurns` / `maxItems` / `catalogDescriptionMax`），
  保证整帧推送的值始终是 UI 量级；
- 重启后投影由注册表从日志重放重建，历史会话同样能看。

右栏接入契约（`sidebarRightTabs.register` 的 `guide` 条目、
`sidebar.right.pane.tab` 面板、`conversation.session.header.actions` 按钮）从
`D:\deepseek\resources\app.asar` 里 0.2.0-rc.2 的 `@deepseek-ai/dsh-client-ui-sidebar-right`
与 `@deepseek-ai/dsh-client-ui-conversation` 源码核实（解包副本在
`G:\工作\dsh\tools\asar-out\`）。

## 安装（desktop profile）

```powershell
# 1) 把插件目录复制进 profile 的 node_modules（与 dsh-asset-library 同法）
#    G:\工作\dsh\dsh-skill-tracer -> C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-skill-tracer
# 2) 在 C:\Users\Administrator\.dsh\profiles\desktop\package.json 里：
#    - dependencies 增加  "dsh-skill-tracer": "file:G:/工作/dsh/dsh-skill-tracer"
#    - dsh.profile.bundles 增加 "dsh-skill-tracer"
# 3) 重启 DeepSeek Harness 桌面端
```

## 配置（cordis.patch.yml 覆盖）

```yaml
- id: skill-tracer
  name: dsh-skill-tracer
  config:
    maxTurns: 8                # 每会话保留的轮次数（最新优先）
    maxItems: 120              # 单轮次保留的条目数（最新优先）
    catalogDescriptionMax: 200 # 目录单条描述截断长度
```

## 已知边界

- PTC mode（`run_code` 程序内的子调用）走 `tool/code-dispatch` 事件而非
  `tool/call`，这类技能加载/调用不在轨迹里（技能加载几乎总是原生单次调用）；
- 子代理（subagent）会话有独立日志，本版本只展示当前会话的轨迹；
- 面板依赖宿主 0.2.x 的 `sidebarRight` / `sidebarRightTabs` 客户端能力，
  缺席时插件静默（不显示标签页），不影响其他功能。

## 自测

```bash
node tools/trace-test.mjs   # 折叠逻辑：目录/模型加载/手势/工具结果/轮次闭合
node --check index.js && node --check client.js && node --check lib/trace.js
```
