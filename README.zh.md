<div align="center">

# dsh-automation

### 在 DSH 里，用一句话安排未来的 Agent 工作。

支持单次与周期任务。每次运行都会创建一个全新、可见的 DSH 会话。

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-automation?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-automation)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![CI](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/alpacachen/dsh-automation/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)

**简体中文** · [English](README.md)

</div>

## ✨ 核心能力

- 🗣️ **自然语言创建**：告诉 Agent 做什么、什么时候做。
- 🗓️ **可靠调度**：支持单次时间、RFC 5545 周期规则和 IANA 时区。
- 🧼 **独立会话**：每次运行都是新会话，不携带之前的聊天历史。
- 👀 **过程可见**：结果摘要、耗时、错误、运行历史和会话入口集中展示。
- 🛡️ **权限可控**：每个任务可选择 DSH 原生只读或完全访问权限。
- 🧭 **引导创建**：使用结果导向模板，或通过对话补齐必要信息。
- 🎛️ **随时管理**：编辑、立即运行、暂停、恢复或删除任务。

## 🚀 快速开始

### 1. 安装

```sh
dsh plugin --profile web add @alpacachen/dsh-automation
```

### 2. 重启 DSH

重启 `dsh web`，让插件完成加载。

### 3. 让 Agent 创建任务

> 明天上午 9 点（Asia/Shanghai）检查这个工作区是否还有发布阻塞，并创建一个单次自动化。

或者：

> 每个工作日下午 6 点整理今天的改动和待办。只报告，不要修改文件。

创建后，在侧边栏打开 **「自动化任务」** 即可管理。

你可以随时点击**「新建自动化」**进入引导创建，也可以在空状态选择结果导向模板。创建前，Agent 会预览名称、计划与时区、工作区、权限、通知和失败暂停策略，并等待确认。升级不会改变已有任务保存的权限。

## 🎛️ 管理与编辑

任务卡支持：

- 修改名称、执行提示词和计划；
- 立即运行、暂停、恢复或恢复并运行；
- 打开最近会话和历史运行；
- 选择仅失败、每次完成或不显示侧边栏通知；
- 查看或修改后续运行权限；修改权限必须再次确认；
- 重试失败运行，并可在连续失败 3 次后自动暂停；
- 删除未来计划，同时保留已有会话。

![自动化任务列表、运行状态与快捷操作](docs/screenshots/automation-list.png)

### 可视化周期编辑器

常用周期无需手写 RRULE：

| 设置 | 实际含义 |
| --- | --- |
| 每天 · 每隔 `1` 天 | 每天执行 |
| 每周 · 每隔 `3` 周 · 周一至周五 | 每 3 周进入一次执行周，并在该周的周一至周五执行 |
| 每月 · 每隔 `2` 个月 · 15 日 | 每 2 个月的 15 日执行 |

还可以设置运行次数或结束日期。特殊规则可切换到 **「高级 RRULE」** 模式。

![可视化周期编辑器](docs/screenshots/schedule-editor.png)

## ⏱️ 运行方式

```text
计划到期 → 进入全局队列 → 创建新会话 → Agent 执行 → 记录结果与会话入口
```

- 所有自动化全局串行执行，不会互相重叠。
- 每次运行默认最多一小时；可通过插件配置 `maxRunDurationMs` 调整。
- 排队中或运行中的工作可以停止，且不会改变后续计划。
- 意外重启时仍在执行的运行会标为**结果未知**，不会误报失败或自动重试。
- 需要关注的结果会在侧边栏「自动化任务」入口显示持久化未读标记。
- 成功运行会清零连续失败次数；任务可选择在连续失败或超时 3 次后自动暂停。
- DSH 必须在计划到期时运行；重启后只补跑最近错过的一次。
- 调度器遇到临时故障时会按有上限的指数退避自动重试。
- 暂停期间的周期会被跳过；「恢复并运行」不会改变原计划。

## 🗓️ 调度格式

| 类型 | 参数 | 示例 |
| --- | --- | --- |
| 单次 | `once_at` | `2026-09-01T01:00:00.000Z` |
| 周期 | `rrule` + `time_zone` + `start_at` | `FREQ=WEEKLY;BYDAY=MO,WE,FR` |

- `once_at` 使用 RFC 3339 UTC 时间。
- `rrule` 使用 RFC 5545 单行规则，不包含 `DTSTART`。
- `time_zone` 使用 IANA 时区，例如 `Asia/Shanghai`。
- `start_at` 使用本地时间格式 `YYYY-MM-DDTHH:mm:ss`。

## 🧰 Agent 工具

| 工具 | 用途 |
| --- | --- |
| `automation_create` | 确认权限及策略后创建任务 |
| `automation_update` | 修改任务设置；权限变更必须确认 |
| `automation_list` | 查看任务与运行状态 |
| `automation_run` | 立即运行一次，不改变原计划 |
| `automation_pause` | 暂停未来调度 |
| `automation_resume` | 恢复任务，可选择立即运行一次 |
| `automation_delete` | 删除任务并取消未来调度 |

## 💡 可以直接这样说

> 「每周一上午 9:30 检查依赖是否有重要更新。」

> 「把发布检查改到周五下午 4 点。」

> 「恢复每日交接，并立即额外运行一次。」

> 「列出所有自动化，并暂停依赖检查。」

内置的发布准备、依赖巡检和每日交接模板都是可编辑草稿；选择模板不会自动发送。

## 开源许可

MIT
