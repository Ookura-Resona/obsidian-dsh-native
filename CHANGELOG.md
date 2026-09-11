# Changelog

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-09-11

大幅增强可用性：错误可解释、崩溃可自愈、环境可体检，并修掉三个真实 bug。

### 新增

- **框选发送三种模式**：只发文件位置引用（默认）/ 只发原文 / 引用 + 原文。
  引用模式只发「文件 + 行:列 + 字数」，让 agent 自己读文件——更省 token，且能精确处理非整行选区。
  新增「框选后」选项：插入输入框等待编辑（默认，不覆盖你已输入的文字）或直接发送。
- **回复里的笔记路径可点击**：vault 内路径渲染成链接，点击在 Obsidian 打开；
  支持 `notes/a.md:120` 带行号，打开后跳到对应行。
- **错误可解释 + 一键动作**：失败时在面板显示卡片（问题是什么 / 怎么修 / 可点的按钮），
  覆盖 node 缺失、未构建 dsh、provider 名错、握手超时、运行时崩溃、凭据问题、权限被拒、会话 id 冲突。
- **崩溃自动重连 + 手动重启**：意外退出后指数退避重试最多 3 次；面板头部新增「重启」按钮。
- **环境检测**：一键体检 Node.js（实际执行 `--version`）、dsh 产物、工作区、DSH_HOME、profile、凭据，
  每项给出 ✅/⚠️/❌ 与具体修复建议。只检测，不自动安装任何东西。
- **诊断区**：集中显示解析后的真实取值、最近一次 initialize 握手的结果与耗时、运行时状态，支持一键复制。
- **对话记录持久化**：保留最近 200 条记录，重载 Obsidian 后仍可查看（可一键清空）。
- 面板头部按钮整组收纳，`.dsh-header-actions` 支持换行。

### 修复

- **双重渲染**：`appendNotice` 记录后会再次走渲染路径，导致面板里每条消息都出现两次。
  现已把「记录」与「渲染」彻底分开（`pushEntry` 只记录并渲染一次，`append*` 只画 DOM）。
- **错误翻译分支永不命中**：`explainError` 匹配「未找到 dsh CLI 产物」时大小写不匹配，
  用户会拿到没用的通用错误卡片。
- **会话 id 复用崩溃**：运行时进程重启后复用旧 `sessionId` 会被服务端拒绝
  （`already exists`）。现在 `sessionId` 绑定运行时进程实例，进程一换就换新 id；
  并且 `session/prompt` 遇到该错误会自动换新 id 重试一次。

### 变更

- `main.js` 末尾额外导出 `explainError`、`buildSelectionPayload`、`checkEnvironment`、`linkifyVaultPaths`，
  供 `dev/` 下的测试脚本复用。
- 新增 [`dev/`](dev/) 目录：纯逻辑回归测试（22 项）、协议探针、`obsidian` 模块测试替身。

### 实测确认（写入文档）

- `initialize` 握手：全新 `DSH_HOME` 下自举 `sdk` profile，耗时 3.7 秒。
- 进程内多轮上下文成立；**跨进程不能续接**（服务端只走 `agents.create`，会话已持久化会拒绝）。
  因此重载 Obsidian / 重启运行时后上下文会重置，仅对话记录保留。
- 协议不转发 `AssistantStreamFrame`，所以**没有实时流式输出**——这是协议边界，非插件缺陷。

## [1.0.0] - 2026-09-11

首个正式版本（更名发布）。

### 变更

- 插件 id 由 `dsh-harness` 改为 **`dsh-native`**，名称由 “DeepSeek Harness” 改为 **“DSH Native”**。
  原因：`dsh-harness` 这个 id 已被另一个 Obsidian 插件占用并登记在官方插件清单中。Obsidian 以 `manifest.json` 的 `id`
  唯一标识插件，同名会导致两者无法共存，也无法上架。
- 插件目录由 `.obsidian/plugins/dsh-harness/` 改为 `.obsidian/plugins/dsh-native/`。
- 仓库由 `obsidian-dsh-harness` 更名为 `obsidian-dsh-native`。

### 新增

- 右侧边栏原生对话面板，助手回复使用 Obsidian 原生 `MarkdownRenderer` 渲染（跟随主题）
- 以 `sdk` profile 启动 DSH 运行时子进程，用换行分帧的 JSON-RPC 2.0 驱动它
- `initialize` 的 `cwd` 默认设为 vault 根目录，agent 直接读写笔记
- 复用同一 `sessionId` 实现多轮上下文
- 命令「把选中内容发给 DSH」：把编辑器选区交给 agent
- 「存入笔记」：把最后一条回复追加到当前活动笔记
- 工具调用活动行与子 agent 启动提示（可在设置里关闭）
- 设置页可改 provider / model / 工作区 / reasoning effort / max tokens，并带「测试连接」
- 无构建步骤：`main.js` 为纯 CommonJS，无 npm 依赖

### 修复

- `turn/end` 的 `reason` 是对象 `{kind:'completed'}` 而非字符串，早期实现会让每轮成功都误报「本轮结束」
- 移除 `main.js` 中硬编码的机器绝对路径，改为基于家目录拼接

### 验证

- `initialize` 握手：在全新 `DSH_HOME` 下自举 `sdk` profile，耗时 3.7 秒
- 完整一轮对话：`running` → `assistant/message` → `turn/end {kind:"completed"}`
- 多轮上下文：第一轮记住数字 42，第二轮复用同一 `sessionId` 正确答出 `42`

## [0.1.0] - 2026-09-11

最初以 `dsh-harness` 为 id 发布，随后发现该 id 与既有插件冲突，已由 **1.0.0** 取代并从 Releases 中撤下。
功能与 1.0.0 相同。
