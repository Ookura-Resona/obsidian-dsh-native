# Changelog

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-11

首个版本。

### 新增

- 右侧边栏对话面板，助手回复使用 Obsidian 原生 Markdown 渲染
- 以 `sdk` profile 启动 dsh 运行时子进程，用换行分帧的 JSON-RPC 2.0 驱动它
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

### 已知限制

协议层不支持取消单轮、无法应答审批弹窗、不呈现流式增量。详见 README 的「已知限制」。
