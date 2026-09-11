# Changelog

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.1] - 2026-09-11

### 变更

- 插件在插件列表和商店里显示的描述改为「在 Obsidian 中以原生面板使用 DeepSeek Harness，通过其 SDK 协议连接。」
- 重写了项目简介与各版本 Release 说明的措辞。

功能与 1.2.0 相同。

## [1.2.0] - 2026-09-11

### 新增

- 界面支持中英文。默认跟随 Obsidian 的界面语言，非中文系统使用英文，也可以在设置里手动指定，改完立即生效。
  错误卡片、环境检测结果、诊断区、命令名和通知都会一起切换。
- 设置页新增「界面」分组，内含「界面语言」选项（跟随 Obsidian / 中文 / English）。

### 变更

- 插件自己抛出的错误现在带有固定的 `code`（`DSH_NO_CLI`、`DSH_TIMEOUT`、`DSH_RUNTIME_EXITED` 等），
  错误分类不再依赖界面语言。DSH 服务端返回的错误仍是英文，按内容匹配。
- 选区引用行的文字随语言切换。

### 测试

- `dev/test-logic.cjs` 增加到 30 项，新增的断言用于检查中英文案是否完整：
  两份文案的键必须一致、源码里用到的每个键都必须存在、占位符必须对应。
  漏翻会让测试失败，不会静默显示成键名。

## [1.1.0] - 2026-09-11

### 新增

- 选中内容可以三种方式发送：只发文件位置引用（默认）、只发原文、两者都发。
  引用形式为「文件 + 行:列 + 字数」，由 agent 自己读文件，比贴原文省 token，也能处理只选中半行的情况。
- 「框选后」可以选择插入输入框等待编辑，或者直接发送。
- 回复里出现的 vault 路径变成可点击链接，支持 `notes/a.md:120` 这种写法，点击后跳到对应行。
- 出错时在面板里显示错误卡片，写明原因、处理建议，并提供可以点击的按钮。
- 运行时意外退出后自动重连，最多 3 次，间隔为 1 秒、2 秒、4 秒；面板头部新增「重启」按钮。
- 设置页新增环境检测，逐项检查 Node.js、dsh 构建产物、工作区目录、DSH_HOME、profile 和凭据。
  只做检查，不自动安装任何东西。
- 设置页新增诊断区，显示各项解析结果、最近一次握手的结果与耗时、运行时状态，可以一键复制。
- 面板保留最近 200 条对话记录，重载 Obsidian 后仍可查看，也可以在设置里清空。

### 修复

- 面板里每条消息会出现两次。原因是 `pushEntry` 记录之后又走了一遍渲染流程，
  现在渲染和记录分开，`pushEntry` 只负责记录并渲染一次。
- 错误卡片里「找不到 dsh 构建产物」这一分支永远不会命中：匹配时大小写不一致，
  用户只能看到通用的错误提示。
- 运行时进程重启后复用原来的会话 id 会导致提问失败（服务端返回 `already exists`）。
  现在会话 id 与运行时进程绑定，进程一换就换新 id；遇到这个错误时也会换新 id 重试一次。

### 其他

- `main.js` 末尾导出了 `explainError`、`buildSelectionPayload`、`checkEnvironment`、`linkifyVaultPaths`，
  供 `dev/` 下的脚本使用。
- 新增 [`dev/`](dev/) 目录，包含逻辑测试、协议探针，以及 `obsidian` 模块的测试替身。

### 顺带确认的行为

- `initialize` 握手在全新的 `DSH_HOME` 下需要先自举 `sdk` profile，实测耗时 3.7 秒。
- 同一个运行时进程内可以多轮对话；进程重启后无法续接，因为服务端只调用 `agents.create`，
  而会话已经落盘，同名创建会被拒绝。
- SDK 服务端不转发 `AssistantStreamFrame`，所以没有流式输出。

## [1.0.0] - 2026-09-11

首个正式版本（更名发布）。

### 变更

- 插件 id 由 `dsh-harness` 改为 `dsh-native`，名称由 “DeepSeek Harness” 改为 “DSH Native”。
  原因是 `dsh-harness` 这个 id 已被另一个 Obsidian 插件占用并登记在官方插件清单中。
  Obsidian 以 `manifest.json` 的 `id` 唯一标识插件，同名会导致两者无法共存，也无法上架。
- 插件目录由 `.obsidian/plugins/dsh-harness/` 改为 `.obsidian/plugins/dsh-native/`。
- 仓库由 `obsidian-dsh-harness` 更名为 `obsidian-dsh-native`。

### 新增

- 右侧边栏对话面板，助手回复使用 Obsidian 的 `MarkdownRenderer` 渲染，跟随主题
- 以 `sdk` profile 启动 DSH 运行时子进程，用换行分帧的 JSON-RPC 2.0 驱动
- `initialize` 的 `cwd` 默认设为 vault 根目录，agent 直接读写笔记
- 复用同一个 `sessionId` 实现多轮上下文
- 命令「把选中内容发给 DSH」，把编辑器选区交给 agent
- 「存入笔记」，把最后一条回复追加到当前活动笔记
- 工具调用活动行和子 agent 启动提示，可以在设置里关闭
- 设置页可以改 provider / model / 工作区 / reasoning effort / max tokens，并带「测试连接」
- 没有构建步骤：`main.js` 是纯 CommonJS，没有 npm 依赖

### 修复

- `turn/end` 的 `reason` 是对象 `{kind:'completed'}` 而不是字符串，早期实现会让每一轮成功都误报「本轮结束」
- 移除 `main.js` 中硬编码的机器绝对路径，改为基于家目录拼接

## [0.1.0] - 2026-09-11

最初以 `dsh-harness` 为 id 发布，随后发现该 id 与既有插件冲突，已由 1.0.0 取代并从 Releases 中撤下。
功能与 1.0.0 相同。
