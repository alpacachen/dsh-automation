<div align="center">

# dsh-automation

### 把事情交给未来的 Agent，让它准时回来完成。

为 DeepSeek Harness 提供持久可靠的单次与周期自动化。每次运行都会唤醒一个全新的 Agent，创建独立且可见的 DSH 会话——不携带昨天的聊天包袱，只专注完成眼前的任务。

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-automation?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-automation)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![CI](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
![License](https://img.shields.io/badge/license-MIT-22c55e)

**简体中文** · [English](README.md)

</div>

## ✨ 把未来的工作，交给未来的 Agent

有些事情不该现在做：明早检查一次发布、每周一审查依赖，或者每天收工前整理交接。dsh-automation 让你直接在 DSH 对话中说明“做什么、什么时候做”，不用再搬到另一个提醒工具。

Agent 会创建任务，插件负责记住时间并在 DSH 进程中等待。时间一到，它会打开一个全新会话开始工作；完整对话和工具历史则一直保留在工作区左侧会话树中。

| 💬 自然安排 | 🗓️ 遵守真实日历 | 🔎 每次运行都可追踪 |
| --- | --- | --- |
| 任务只由 Agent 创建，一句话就能说明需求。 | RFC 5545 周期规则配合 IANA 时区，跨夏令时仍保持本地时间。 | 每次尝试都有状态、时间、错误信息和对应的 DSH 会话。 |
| **🧼 每次从零开始** | **🎛️ 随时掌控** | **💾 重启后依然记得** |
| 每次运行都是新会话，不带入之前的聊天历史。 | 可编辑、立即运行、暂停、恢复、查看历史或删除。 | 版本化 JSON 与“仅补跑最近一次”策略让计划持久且可预测。 |

## 🚀 三步开始使用

### 1. 安装

```sh
dsh plugin --profile web add @alpacachen/dsh-automation
```

安装后重启 `dsh web`，让插件 bundle 完成加载。你可以检查当前 Profile：

```sh
dsh --profile web --dump-config
```

### 2. 让 Agent 安排一件事

试试单次任务：

> 明天上午 9 点（上海时间）检查这个工作区是否还有发布阻塞，并创建一个单次自动化任务。

或者建立周期习惯：

> 每个工作日下午 6 点（Asia/Shanghai）检查今天的改动，整理一份简短交接。只报告，不要修改文件。

Agent 会调用 `automation_create`，确认规范化后的时间，并返回任务 ID。

### 3. 打开「自动化任务」

在 DSH 侧边栏中选择 **「自动化任务」**。管理面板会告诉你哪些任务正在生效、下一次什么时候运行，以及之前发生了什么。

你可以在这里：

- 修改任务名称、执行提示词或计划；
- 立即运行任务；
- 暂停或恢复日历计划；
- 恢复已暂停的任务，并马上额外运行一次；
- 打开最近会话或任意一条运行历史；
- 删除未来计划，同时保留已经产生的会话。

周期计划提供可视化的每天、每周、每月编辑器，并支持间隔与结束条件；不常见的 RFC 5545 规则仍可切换到 **「高级 RRULE」** 编辑。界面会自动跟随 DSH 当前语言、明暗主题、字体、颜色和交互风格。

## ⏱️ 一次运行是怎样发生的

```text
计划时间到达
    ↓
运行进入全局队列
    ↓
创建一个全新、持久化的 DSH 会话
    ↓
使用 danger-full-access 且不弹出审批，执行任务提示词
    ↓
状态与会话入口写回「自动化任务」
```

插件中的任务始终全局串行执行。再慢的任务也不会和另一条自动化重叠；完成后的会话会继续留在工作区会话树中。

## 🗓️ 调度模型

| 类型 | 必填字段 | 含义 |
| --- | --- | --- |
| **单次** | `once_at` | 一个规范的 RFC 3339 UTC 时间点。 |
| **周期** | `rrule`、`time_zone`、`start_at` | 使用 IANA 时区本地墙钟时间作为锚点的 RFC 5545 规则。 |

单次任务输入：

```json
{
  "name": "发布检查",
  "prompt": "检查当前工作区的发布状态并报告阻塞项。",
  "once_at": "2026-09-01T01:00:00.000Z"
}
```

周期任务输入：

```json
{
  "name": "工作日交接",
  "prompt": "检查今天的改动并整理简洁的交接说明。不要修改文件。",
  "rrule": "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=0",
  "time_zone": "Asia/Shanghai",
  "start_at": "2026-09-01T18:00:00"
}
```

任务到期时 DSH 必须正在运行。停机后恢复时，周期任务只补跑最近错过的一次，不会回放整段积压。暂停期间的周期会被跳过；**「恢复并运行」** 会立即额外运行一次，但不会改变原来的日历锚点。

## 🧰 Agent 工具

| 工具 | 用途 |
| --- | --- |
| `automation_create` | 为当前工作区创建单次或周期任务。 |
| `automation_update` | 修改任务名称、提示词或计划，无需删除重建。 |
| `automation_list` | 查看任务、计划、下次运行时间与最近历史。 |
| `automation_pause` | 停止未来调度，但不删除任务。 |
| `automation_resume` | 恢复调度，也可以同时立即运行一次。 |
| `automation_delete` | 永久删除任务并取消未来调度。 |

创建任务仍然仅限 Agent；已有任务的定义既可以让 Agent 修改，也可以直接在 UI 中编辑。

## 💡 你可以直接这样说

> 「明天上午 10 点运行完整测试，并解释所有失败。」

> 「每周一上午 9:30 检查依赖是否有重要更新。只报告，不要修改文件。」

> 「列出这个工作区的所有自动化，然后把发布提醒改到周五下午 4 点。」

> 「恢复每周审查，并且现在立刻运行一次。」

> 「删除旧的站会自动化，但保留它以前产生的会话。」

## 💾 持久化与恢复

状态文件位于：

```text
$DSH_HOME/automation/state.json
```

版本化 JSON 快照保存任务定义、调度状态和最近 20 条运行摘要。所有写入都会串行执行，并通过原子替换落盘。完整对话和工具历史仍由 DSH 原有的会话持久化负责。

调度器完全运行在 DSH 进程内：不依赖 cron、launchd、systemd、Windows 任务计划程序、数据库或外部 Worker。

## ⚠️ 完全访问权限

> [!WARNING]
> 每次定时和手动运行都会使用 `danger-full-access`，并关闭审批提示。任务提示词能够以当前操作系统用户的权限执行命令和修改文件，但无法绕过系统权限、sudo、OAuth 或缺失的凭据。

请像编写无人值守脚本一样认真编写提示词。如果任务只应该读取和检查数据，请明确写出“不要修改文件”。

## 🧑‍💻 开发

```sh
pnpm check
pnpm test
pnpm test:coverage
pnpm build
```

测试覆盖持久化失败、RRULE 与夏令时、错过运行、暂停与恢复、立即运行、全局串行、长计时器、重启恢复、Agent 会话创建、工具、管理 API、国际化以及 DSH 风格 UI。

本地 Profile 开发：

```sh
pnpm build
cd "$DSH_HOME/profiles/web"
pnpm add '@alpacachen/dsh-automation@link:/absolute/path/to/automation'
```

## 📦 发布

CI 会验证每个 Pull Request 以及所有推送到 `main` 的提交。只需更新 `package.json` 中的稳定 SemVer，发布工作流就会自动完成测试、构建、带 Provenance 的 npm 发布、Git Tag 与 GitHub Release——无需 npm Token。

## 开源许可

MIT
