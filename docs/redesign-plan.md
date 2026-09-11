# Automation 插件 UI 重设计方案

## 诊断：现在为什么难用

盘点了 `src/client/index.tsx`(1258 行) 与 `styles.css`(1452 行) 后，问题集中在五处：

1. **单列长卡片无法扫视**。每个任务是一张堆叠了标题/状态/下次运行/健康条/最新结果/4 个操作按钮/2 个折叠区的巨型卡片。3 个任务就撑满一屏，10 个任务只能靠滚动。
2. **信息被埋在折叠区**，且 `<details>` 无状态记忆 —— 每次 5 秒轮询重渲染后又收起。想看 workspace 或权限就得反复展开。
3. **没有检索手段**。无搜索、无状态筛选、无排序，任务按服务端 `Object.values` 的任意顺序排列。
4. **编辑是弹窗叠弹窗**，且整个表单用的是原生 `<select>/<input type=checkbox>`，与宿主设计语言完全脱节。
5. **1452 行 CSS 在重造宿主已有的轮子** —— 按钮、状态点、chip、模态、菜单，`@deepseek-ai/dsh-client-ui-primitives` 全都有，而它是平台种子词（宿主运行时直供，零打包体积、零模块表风险）。

宿主自己的 `dsh-client-ui-schedule` 就是这么写的：只 require `primitives` + `react`，`dsh.client.inject` 里声明 primitives，peer 只留 cordis。

## 目标形态：左右双栏 master–detail

`shell.overlay` 仍是正确挂载点（`sidebar.right.pane.tab` 是 per-session 的资源查看器，automation 是全局列表，语义不符）。改的是面板内部。

```
┌──────────────────────────────────────────────────────────────────┐
│ ⏱ 自动化    12 个任务   ● 调度器正常        [＋ 新建] [⟳] [✕]      │
├────────────────────────┬─────────────────────────────────────────┤
│ 🔍 搜索…                │  每日发布检查              ● 运行中      │
│ (全部)(活跃)(暂停)(完成) │  ┌───────────────────────────────────┐  │
│                        │  │ 下次  2 小时后                     │  │
│ ●  每日发布检查      ⋯ │  │      2026-09-11 18:00 Asia/Shanghai│  │
│    2 小时后             │  └───────────────────────────────────┘  │
│ ─────────────────────  │  ▇▇▇▁▇▇▇▁▇▇▇▇  最近 12 次               │
│ ●  依赖巡检        ⚠2  │                                         │
│    明天 09:00           │  [▶ 立即运行][⏸ 暂停][✎ 编辑][⋯]        │
│ ─────────────────────  │                                         │
│ ●  交接摘要             │  最新结果 ─────────────────────────────  │
│    已完成               │  已检查 14 个包，2 个需升级              │
│                        │                                         │
│                        │  概览 ────────────────────────────────  │
│                        │  排程   每天 · Asia/Shanghai            │
│                        │  工作区 automation  权限 只读            │
│                        │  执行   全新会话   通知 仅失败           │
│                        │  Agent  默认 · 默认模型 · 无技能         │
│                        │  任务 ID  a1b2c3…            [复制]     │
│                        │                                         │
│                        │  运行历史 (23) ────────────────────────  │
│                        │  ▸ ● 成功 · 定时 · 1分12秒   09-11 08:00│
│                        │  ▸ ● 失败 · 手动 · 4秒       09-10 22:31│
└────────────────────────┴─────────────────────────────────────────┘
```

左栏是**可扫视的紧凑列表**，右栏是**选中任务的全部信息，默认全部展开**。这一步同时解决扫视、密度、折叠区失忆三个问题。

## 信息落位表（逐项对照，确保零丢失）

用户的硬要求是不减少功能与信息。下表把现有每一处 UI 元素映射到新位置，并标出新增暴露的字段。

### 面板级

| 现在 | 新位置 |
|---|---|
| 侧栏按钮 + 未读角标 | 不变（`sidebar.footer.action`） |
| 标题 + `taskCount` | 面板头部 |
| 错误横幅 | 面板头部下方常驻横幅 |
| 调度器 `retrying`/`stopped` 横幅 | 头部**常驻健康指示点** + 异常时横幅。**新增**：`healthy` 态现在也可见（原来只在出错时才有任何提示） |
| — | **新增**：健康点 HoverCard 展示 `consecutiveFailures` / `lastFailedAt` / `retryAt`（原来这三个字段从不显示） |
| 加载态 | 左栏骨架 + 头部 `IconLoadingOutline16` |
| 空态 + 3 个示例卡 + `exampleDraftHint` | 保留，占据整个面板宽度 |
| `＋ 新建` 按钮 | 头部。**改进**：`workspaceId === undefined` 时禁用并用 Tooltip 说明原因，而不是点了才报错 |
| 刷新按钮 / 关闭按钮 | 头部 |

### 任务列表行（左栏，紧凑）

状态点 · 名称 · 下次运行相对时间 · 连续失败 chip · `⋯` 菜单（运行/暂停/恢复/编辑/删除）。

排序：运行中优先 → `nextRunAt` 升序（null 排末）。
筛选：搜索框（匹配 name + prompt）+ 状态 Pill 组。

### 任务详情（右栏，默认全展开）

| 现有元素 | 新位置 |
|---|---|
| 名称 + 状态标签 + 连续失败 chip | 详情头部 |
| `nextRunAt` 相对时间 + 绝对时间 + 时区 | 突出的"下次运行"块；`null` 显示 `—` |
| 12 段健康条（`title` 提示） | 保留，改用 `Tooltip` 组件（原生 title 延迟长、样式不可控） |
| 最新结果 summary | 独立区块 |
| 运行/停止/暂停/恢复/恢复并运行 | 主操作行 |
| 打开最新会话 / 编辑 / 删除 | 主操作行 + `⋯` 菜单 |
| 删除内联确认（会挤动布局） | 改用 `Modal`，不再撑动布局 |
| 折叠"详情"9 个 fact | **概览网格，默认全部可见**：排程、工作区(cwd)、执行目标、权限、Agent 执行、通知策略、连续失败、失败后暂停、任务 ID + 复制 |
| — | **新增**：`createdAt`、`createdBySessionId`、`pausedAt`、`pausedNextRunAt`（现有 UI 从不显示这 4 个字段） |
| 折叠"最近运行"列表 | 运行历史区块，每条是 `DisclosureRow`：收起显示状态/触发方式/时长/时间，展开显示 summary、error、`enqueuedAt`/`startedAt`/`finishedAt`、`executionTarget`、run id |
| 单条运行的 重试 / 打开会话 按钮 | 保留在展开区 |

### 编辑表单

从"弹窗叠弹窗"改为**右栏内联编辑**（左栏列表保持可见，始终知道在编辑哪个任务）。字段一个不减：

- 基本：name、prompt
- 排程：once/recurring 切换；once 的 `fireAt`；recurring 的 可视/高级 规则模式、frequency、interval、weekdays、monthDay、ends(never/count/until)、count、until、timeZone、startAt；不支持规则的提示
- Agent 执行：agentPreset（含 trust、description、broken/unavailable 标记）、provider、model（含 `notInCatalog` 标记）、skills（含 description、`modelInvocable` 标记、unavailable 标记）、`modelFailures` 告警、options 加载/失败态
- 通知：notificationPolicy 三选、pauseAfterConsecutiveFailures
- 权限：permission 下拉（含 description、sandbox、approval）、`approval === 'ask'` 告警、变更需勾选确认

控件全部换成 primitives：原生 `<select>` → 基于 `Menu` 的 `Select` 封装（8 处枚举选择器共用）；weekdays 复选框 → `Pill` active 态；pauseAfterFailures → `Switch`；技能列表 → 带搜索框的可勾选列表 + 已选 `Tag` chips；规则模式切换 → `Pill` 组。

保存按钮的启用条件（`changed && configValid && 权限已确认`）逻辑原样保留。

## 实现要点

**依赖**：`package.json` 的 `dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-primitives`，devDependencies 加 `^0.1.5-rc.2` 供 typecheck。**不加 peerDependencies**（对齐官方 `dsh-client-ui-schedule` 的写法）。它是种子词，esbuild 的 `@deepseek-ai/*` external 会保留为 `require()`，宿主运行时直供 —— 与上次 `dsh-client-runtime` 那次故障性质完全不同（那个包已停止发布，这个是宿主必然提供的）。

**图标**：20+ 个手绘 SVG 换成 primitives 图标（已逐个核对存在）。仅 shield / bell / calendar 三个语义图标 primitives 没有，保留自绘。`iconPaths` 表从 18 项缩到 3 项。

**轮询合并**：现在侧栏角标和面板各自跑一个 5 秒 `/tasks` 轮询。合并为单一共享 store，面板打开时 5 秒、关闭时 30 秒，两处消费同一份数据（请求量减半且不再出现两处数字不一致）。

**响应式**：视口窄于 ~880px 时收为单栏，详情替换列表并带返回按钮。

**CSS**：`styles.css` 重写，只保留布局与 primitives 无法覆盖的部分，继续只用 `--dsw-*` 设计令牌（现在就没自定义变量，这点保持）。预计从 1452 行降到 ~450 行。

**无障碍**：保留焦点陷阱、`aria-modal`、`aria-live`、Escape 关闭；新增列表 ↑/↓ 键导航。

## 不改动的部分

服务端（`controller.ts`/`scheduler.ts`/`runner.ts`/`api.ts`/`store.ts`）零改动。REST 面不变 —— 已确认没有创建任务的 POST 接口，新建仍走"注入对话草稿引导 agent 创建"这条既有路径。`locales.ts` 的 288 个 key 基本复用，仅为新增字段（createdAt、pausedAt、搜索、筛选等）追加约 15 个 key，中英双语同步。

## 执行顺序

1. `package.json`：加 primitives 依赖声明，版本 → `0.3.20`
2. `locales.ts`：追加新增文案（中英）
3. 新建 `src/client/primitives.tsx`：`Select` 封装 + 图标别名 + `statusTone`(状态 → `TagTone`/`StateDotState` 映射) 等共享件
4. 拆分 `src/client/index.tsx`：`TaskList` / `TaskDetail` / `TaskEditor` / `AutomationPanel` / `SchedulerHealth`
5. 重写 `styles.css`
6. `pnpm build` + typecheck，核对 `lib/client.js` 的 `require()` 闭包（确认只新增 primitives 这一个种子词）
7. 交你手动测试

## 需要你确认的取舍

编辑表单我打算做成**右栏内联**（左栏列表保持可见）。另一种做法是保留独立全屏 `Modal`（表单字段多，全屏更宽敞）。我倾向内联，因为它避免了"弹窗叠弹窗"这个当前最大的交互痛点 —— 若你更想要全屏表单，我改。
