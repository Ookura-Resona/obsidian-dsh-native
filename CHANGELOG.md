# Changelog

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
