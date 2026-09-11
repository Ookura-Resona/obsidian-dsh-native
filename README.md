# DSH Native

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）作为**原生 Obsidian 面板**使用 —— 走官方 SDK 协议驱动，不嵌网页、不注入、无构建依赖。

**DSH Native** 是一个 Obsidian 桌面端插件。它不是把 DSH 的 Web 界面塞进 iframe，而是直接以子进程方式驱动 DSH 运行时，
用 Obsidian 自己的界面渲染对话。结果是：**极轻、极稳、原生**。

---

## 为什么选它

### 1. 不注入、不改你的 DSH 安装

插件不往你的 DSH profile 写补丁层、不向它服务的 `index.html` 注入脚本、不去操作前端的 React 内部状态。
它只**读**你的 DSH 配置来定位运行时，其余什么都不动。

对比之下，iframe 类方案需要：写 `<DSH_HOME>/profiles/web/cordis.patch.yml`、注册 `webServer.tapIndex` 往页面注入桥接脚本、
再用原生 setter 驱动 React 受控 textarea。能用，但那是在 DSH 的前端实现上做文章。

### 2. 抗版本漂移

本插件只依赖 DSH 的**官方 SDK 协议**：3 个请求（`initialize` / `session/prompt` / `shutdown`）
加 4 个通知（`session.event` / `session.status` / `subagent.started` / `subagent.finished`），换行分帧的 JSON-RPC 2.0。

**DSH 前端怎么改版都与本插件无关。** 而依赖 DOM 与 React 内部实现的方案，必须跟着 DSH 的前端跑——
这也是为什么那类插件通常要维护「兼容/不兼容版本区间」，并在每次 DSH 更新后重写桥接。

### 3. 真正的原生界面

对话渲染用的是 Obsidian 自己的 `MarkdownRenderer`：跟随你的主题、字体、字号、深色模式，
代码块就是 Obsidian 的代码块。不需要缩放补丁，也不需要「底部垫高」来躲状态栏。

也因为没有 iframe，就**没有 cookie 认证问题**——iframe 方案会因为 `SameSite=Strict` 无法自动认证，
只能去解析 DSH 启动日志里的 `?token=` 一次性凭证，并引导你改用浏览器打开。

### 4. 极小、可通读

| | 本插件 |
|---|---|
| 源码 | **1 个文件，约 33 KB** |
| 运行时依赖 | **0** |
| 构建步骤 | **无**（纯 CommonJS，改完直接重载） |

整个插件你花十几分钟能读完。相比之下，编译后动辄 300 KB+、还要注入前端脚本的方案，基本无法审计。

### 5. 边界干净

DSH 服务与你手动跑的 `dsh web` 完全独立：本插件用自己的 `sdk` profile 起进程，
不占用 3080 端口、不与 Web GUI 抢服务、退出 Obsidian 即结束。

---

## 需要说清楚的取舍

诚实起见：**iframe 方案在功能完整度上更强**，因为它面板里跑的就是完整的 DSH Web UI，审批交互、取消单轮、
流式输出、以及 DSH 将来新增的任何前端功能都天然具备。

本插件受限于 SDK 协议暴露的能力，**没有**以下功能（详见[已知限制](#已知限制)）：

- 无法应答审批弹窗（协议没有服务端→客户端请求）
- 无法取消单轮（协议没有取消方法，「停止」只能关进程）
- 不呈现流式增量（助手消息按 step 整段出现）

如果你需要的是「完整 DSH 体验」，iframe 类插件更合适；
**如果你要的是一个轻、稳、原生、可审计的 DSH 客户端，选本插件。**

---

## 它怎么工作

以子进程方式启动 DSH 运行时的 `sdk` profile：

```
node <checkout>/apps/cli/lib/bin.js --profile sdk
```

再按 [`@deepseek-ai/dsh-sdk-protocol`](https://github.com/deepseek-ai/deepseek-harness) 的规定，
用换行分帧的 JSON-RPC 2.0 在 stdin/stdout 上驱动它。

三个关键设计点：

- **`initialize` 的 `cwd` 就是 agent 的工作区根目录**（即 `session.header.cwd`）。默认设为 vault 根目录，因此 agent 直接在你的笔记上工作。
- **多轮对话靠复用同一个 `sessionId`**：服务端对同一 id 做 `getOrCreateSession`，后续 `session/prompt` 会接着同一上下文继续。
- **无构建步骤**：因为协议很小，插件自己实现了这层客户端。

---

## 要求

| 项 | 要求 |
|---|---|
| Obsidian | 桌面端（`isDesktopOnly: true`），依赖 Node 的 `child_process` |
| Node.js | 能在 Obsidian 子进程里调用到，建议在设置里填绝对路径 |
| DSH | 一份**已构建**的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库，即 `apps/cli/lib/bin.js` 存在 |
| 凭据 | DSH 自己的凭据解析（`$DSH_HOME/.credentials.yaml`、环境变量或 `.env`）。**插件不接触、不转发任何密钥** |

`$DSH_HOME` 默认是 `~/.dsh`，与 DSH CLI 一致；只有配置目录不在默认位置时才需要填。

## 安装

### BRAT

用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `Ookura-Resona/obsidian-dsh-native`。

### 手动

1. 把 `main.js`、`manifest.json`、`styles.css` 放进 `<你的 vault>/.obsidian/plugins/dsh-native/`
2. 设置 → 第三方插件 → 关闭「受限模式」→ 在「已安装插件」里打开 **DSH Native**
3. 在插件设置里点「自动探测」，再点「测试连接」
   看到「连接成功：deepseek-harness-sdk-runtime v0.0.1」即链路打通

## 使用

- 点左侧栏机器人图标，或运行命令 **`DSH Native: 打开对话面板`**
- 输入框：**Enter 发送，Shift+Enter 换行**
- 命令 **`DSH Native: 把选中内容发给 DSH`**：把编辑器选区（未选中则取全文）直接发给 agent
- 面板头部：
  - **新会话** —— 换一个 `sessionId`，清空面板
  - **存入笔记** —— 把最后一条回复追加到当前活动笔记（无活动笔记则复制到剪贴板）
  - **停止** —— 关掉运行时进程

### 设置项

| 设置 | 说明 |
|---|---|
| dsh CLI 产物（bin.js） | 启动器绝对路径；留空自动探测常见位置 |
| node 可执行文件 | 留空自动探测，再回退为 PATH 上的 `node` |
| 工作区目录（cwd） | 作为 `initialize` 的 cwd。**留空 = vault 根目录** |
| DSH_HOME | 留空 = DSH 默认（`~/.dsh`） |
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

- 沙箱由 DSH 提供，不是本插件：base 系 profile 默认使用 **`workspace-write`** 权限预设，**写入被限制在会话工作区（默认 vault）与平台临时目录内**；读和网络不受限。
- 因此把工作区目录改成 vault 之外的位置，就等于让 agent 能写那些位置。**建议保持默认。**
- 插件把 DSH 子进程的环境继承自 Obsidian 进程，额外只加你填的 `DSH_HOME`。
- 插件自身不发起任何网络请求，也不含遥测。

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

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— DSH 本体
- [Obsidian 插件开发文档](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)

## License

[MIT](LICENSE)
