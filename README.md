# DeepSeek Harness for Obsidian

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）作为 AI 协作者嵌进 Obsidian：
**vault 就是 agent 的工作目录**，它可以直接读你的笔记、写文件、跑多步任务。

An Obsidian desktop plugin that embeds the DeepSeek Harness (`dsh`) runtime as a native
AI collaborator in your vault — no iframe, no webview: it drives a real `dsh` subprocess.

---

## 它和「把网页塞进 iframe」有什么不同

这是一个真正驱动 dsh 运行时子进程的原生插件。它以子进程方式启动 `sdk` profile：

```
node <checkout>/apps/cli/lib/bin.js --profile sdk
```

再按 [`@deepseek-ai/dsh-sdk-protocol`](https://github.com/deepseek-ai/deepseek-harness) 的规定，
用**换行分帧的 JSON-RPC 2.0** 在 stdin/stdout 上驱动它。协议面很小：

| 方向 | 方法 |
|---|---|
| 客户端 → 服务端 | `initialize` / `session/prompt` / `shutdown` |
| 服务端 → 客户端 | `session.event` / `session.status` / `subagent.started` / `subagent.finished` |

三个关键设计点：

- **`initialize` 的 `cwd` 就是 agent 的工作区根目录**（即 `session.header.cwd`）。插件默认把它设为 vault 根目录，因此 agent 直接在你的笔记上工作。
- **多轮对话靠复用同一个 `sessionId`**：服务端对同一 id 做 `getOrCreateSession`，后续 `session/prompt` 会接着同一个 agent 的上下文继续。
- **没有构建步骤**。因为协议很小，插件自己实现了这层客户端，`main.js` 是纯 CommonJS，Obsidian 直接加载，不需要 npm 依赖、不需要打包。

## 特性

- 右侧边栏对话面板，助手回复用 Obsidian 原生 Markdown 渲染
- 命令 `把选中内容发给 DSH`：把编辑器选区直接交给 agent
- `存入笔记`：把最后一条回复追加到当前笔记
- 工具调用活动行（可关闭），子 agent 启动提示
- 设置页可改 provider / model / 工作区 / reasoning effort / max tokens，并带「测试连接」

## 要求

| 项 | 要求 |
|---|---|
| Obsidian | 桌面端（`isDesktopOnly: true`），依赖 Node 的 `child_process` |
| Node.js | 能在 Obsidian 子进程里调用到，建议在设置里填绝对路径 |
| dsh | 一份**已构建**的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 仓库，即 `apps/cli/lib/bin.js` 存在 |
| 凭据 | dsh 自己的凭据解析（`$DSH_HOME/.credentials.yaml`、环境变量或 `.env`）。**插件不接触、不转发任何密钥** |

`$DSH_HOME` 默认是 `~/.dsh`，与 dsh CLI 一致；只有配置目录不在默认位置时才需要填。

## 安装

### 手动

1. 把 `main.js`、`manifest.json`、`styles.css` 放进 `<你的 vault>/.obsidian/plugins/dsh-harness/`
2. 设置 → 第三方插件 → 关闭「受限模式」→ 在「已安装插件」里打开 **DeepSeek Harness**
3. 在插件设置里确认 **dsh CLI 产物**路径（点「自动探测」），再点 **测试连接**
   看到「连接成功：deepseek-harness-sdk-runtime v0.0.1」即链路打通

### BRAT

本仓库尚未发布 Release。发布后可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat)
添加 `Ookura-Resona/obsidian-dsh-harness` 来安装与自动更新。

## 使用

- 点左侧栏机器人图标，或运行命令 **`DeepSeek Harness: 打开对话面板`**
- 输入框：**Enter 发送，Shift+Enter 换行**
- 面板头部：
  - **新会话** —— 换一个 `sessionId`（同一运行时进程内），清空面板
  - **存入笔记** —— 把最后一条回复追加到当前活动笔记（无活动笔记则复制到剪贴板）
  - **停止** —— 关掉运行时进程

### 设置项

| 设置 | 说明 |
|---|---|
| dsh CLI 产物（bin.js） | 启动器绝对路径；留空自动探测常见位置 |
| node 可执行文件 | 留空自动探测，再回退为 PATH 上的 `node` |
| 工作区目录（cwd） | 作为 `initialize` 的 cwd。**留空 = vault 根目录** |
| DSH_HOME | 留空 = dsh 默认（`~/.dsh`） |
| profile | 默认 `sdk`，一般不用改 |
| provider / model | 默认 `deepseek-official` / `deepseek-v4-flash-vision-exp` |
| reasoning effort | 默认 `high`，留空则用模型默认值 |
| max tokens | 0 = 模型默认值 |
| 显示工具调用 | 是否显示 🔧 工具活动行 |

## 已验证的行为

开发时用真实 CLI 跑过三轮验证（非推断）：

1. **握手**：在全新 `DSH_HOME` 下自举 `sdk` profile 并完成 `initialize`，耗时 3.7 秒，返回 `{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}`
2. **完整一轮对话**：`session/prompt` 被接受，依次收到 `session.status: running` → `assistant/message` → `turn/end {kind:"completed"}`，助手文本正确提取
3. **多轮上下文**：第一轮让 agent 记住数字 42，第二轮（复用同一 `sessionId`）它答出 `42`，上下文延续成立

测试还抓出并修掉一个真实 bug：`turn/end` 的 `reason` 是**对象** `{kind:'completed'}` 而不是字符串，
早期实现会让每轮成功都误报「本轮结束」。

## 已知限制

这些是**协议本身的边界**，不是插件的缺陷：

1. **无法取消单轮**。协议层没有取消方法，「停止」只能关掉整个运行时进程；下一轮发送时会自动重启。
2. **无法应答审批弹窗**。协议没有服务端→客户端请求，SDK 模式下审批无处可答。工作区内的写入本来就无需审批；一旦某操作需要提权，它会 **fail closed（直接失败）**——这是安全的一侧。
3. **不呈现流式增量**。`assistant/attempt` 的 stream 记录没有重建，助手消息在每个 step 结束时整段出现。
4. **一次一轮**。面板在等待本轮结束时不允许再发送；即使发了，运行时也会把它当 followup 排队。
5. **子 agent 只显示一行提示**，没有把子会话事件并进主面板。
6. `stderr` 上的 `dsh: reasoning:` 推理增量被刻意过滤，不逐条铺进面板。

## 安全说明

- 沙箱由 dsh 提供，不是本插件：base 系 profile 默认使用 **`workspace-write`** 权限预设，**写入被限制在会话工作区（默认 vault）与平台临时目录内**；读和网络不受限。
- 因此把工作区目录改成 vault 之外的位置，就等于让 agent 能写那些位置。**建议保持默认。**
- 插件把 dsh 子进程的环境继承自 Obsidian 进程，额外只加你填的 `DSH_HOME`。

## 开发

源码就是 `main.js` 一个文件，含三部分：

| 部分 | 作用 |
|---|---|
| `DshRuntime` | JSON-RPC 客户端：spawn 子进程、分帧、请求/响应、通知分发、关闭阶梯（stdin EOF → SIGTERM → SIGKILL） |
| `DshView` | 对话面板：消息渲染、本轮结束判定、工具活动行 |
| `DshSettingTab` | 设置页与连接测试 |

没有构建步骤：改完 `main.js` 直接在 Obsidian 里重载插件（`Ctrl+R`）即可。

`main.js` 末尾额外导出了 `DshRuntime` 与 `DshView`，便于在 Obsidian 之外做协议冒烟测试
（用一个 `obsidian` 模块测试替身即可 `require`）；这不影响 Obsidian 把 `module.exports` 当插件类加载。

本轮结束的判定值得注意：必须先在 `session.status` 上观察到 `running`，之后收到 `turn/end`
或 `running → idle` 才算结束。要求「见过 running」是为了排除上一轮遗留的 `idle` 把本轮提前判定为完成。

## 相关

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— dsh 本体
- [Obsidian 插件开发文档](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)

## License

[MIT](LICENSE)
