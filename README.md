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
| 源码 | **1 个文件**（去掉中英词典后约 1800 行） |
| 运行时依赖 | **0** |
| 构建步骤 | **无**（纯 CommonJS，改完直接重载） |

读一遍用不了半小时。相比之下，编译后动辄 300 KB+、还要注入前端脚本的方案，基本无法审计。

### 5. 边界干净

DSH 服务与你手动跑的 `dsh web` 完全独立：本插件用自己的 `sdk` profile 起进程，
不占用 3080 端口、不与 Web GUI 抢服务、退出 Obsidian 即结束。

---

## 功能一览

### 对话面板

右侧边栏的原生面板。助手回复走 Obsidian 的 Markdown 渲染器，跟随你的主题；工具调用以紧凑活动行显示（可关闭）。

### 框选发送：三种模式

命令 `把选中内容发给 DSH` 支持三种发法，在设置里切换：

| 模式 | 发什么 | 适用 |
|---|---|---|
| **只发文件位置引用**（默认） | `[选中片段] 文件：notes/a.md｜范围：第 12 行第 3 列 → 第 15 行第 8 列（共 87 字符）｜请读取该文件对应范围后处理` | **推荐**。agent 自己读文件，比贴原文更省 token，且能精确处理非整行选区 |
| 只发选中的原文 | 你选中的文字 | 选中的是不在 vault 里的内容，或想让 agent 直接看到原文 |
| 引用 + 原文 | 两者都给 | 既想省一次读取、又想让它看到确切文字 |

还可以选「框选后」的行为：**插入输入框等你补一句要求**（默认，不会覆盖你已输入的文字），或**直接发送**。

### 回复里的笔记路径可点击

助手回复中出现的 vault 内路径会自动变成可点击链接，点击直接在 Obsidian 打开。
支持 `notes/a.md:120` 这种带行号的写法，打开后会**跳到对应行**（在代码块、行内代码里不会误伤）。

这让「agent 说它改了哪个文件」和「你去看那个文件」之间不再需要手动找。

### 错误可解释 + 一键动作

失败时不再只丢一句 `spawn ENOENT`，而是在面板里给出一张卡片：**这是什么问题 + 怎么修 + 可直接点的按钮**。

覆盖：找不到 node、没构建 dsh、provider 名错、握手超时、运行时崩溃、凭据问题、权限被拒、会话 id 冲突。
按钮动作包括「重试 / 打开设置 / 检测环境 / 重启运行时 / 开新会话」。

### 自动重连 + 手动重启

运行时意外退出时检测到并显示原因；开启自动重连后会**指数退避重试最多 3 次**（1s → 2s → 4s）。
面板头部也有「重启」按钮，可以随时手动拉起，不必重启 Obsidian。

> 注意：重连/重启后上下文会重置——见下面的[会话与上下文](#会话与上下文重要)一节。

### 环境检测

设置页里一键逐项体检：Node.js（实际执行 `--version`）、dsh 构建产物、工作区目录、DSH_HOME、
profile 是否初始化、凭据是否存在。每项给出 ✅ / ⚠️ / ❌ 与**具体修复建议**。

**只检测，不自动安装任何东西**——插件保持轻量，不做你没要求的副作用。

### 诊断区

设置页集中显示解析后的真实取值（node 路径、bin.js、DSH_HOME、工作区、provider/model…）、
**最近一次 initialize 握手的结果与耗时**、以及面板运行时状态，并支持一键复制，方便排查问题时贴出来。

### 记录持久化

面板保留最近 200 条对话记录，重载 Obsidian 后仍可查看（在设置里可一键清空）。
**记录只是记录，不含上下文**——原因见下。

### 中英双语界面

界面文案跟随 Obsidian 的界面语言（非中文系统自动用英文），也可以在设置里强制指定中文或英文。
错误卡片、环境检测结果、诊断区、命令名、通知都会一起切换。

翻译完整性由测试保证：中英两份词典的 key 集合必须完全一致，源码里用到的每个词条都必须存在，
占位符也必须一一对应——漏翻会直接让测试失败。

---

## 会话与上下文（重要）

这是协议层的硬约束，实测确认（见 [`dev/probe-session-resume.cjs`](dev/probe-session-resume.cjs)）：

| 场景 | 行为 |
|---|---|
| 同一个运行时进程内继续对话 | ✅ 接着同一上下文，多轮成立 |
| 运行时进程重启后复用旧会话 id | ❌ 服务端拒绝：`[-32603] session "<id>" already exists` |
| 重启后换新会话 id | ✅ 正常开始新会话 |

原因是 SDK 服务端只会调 `agents.create`，而会话已经持久化到磁盘，同名创建会被拒绝；
协议里也**没有** resume 入口。

因此：

- 插件把 `sessionId` 的生命周期绑定到运行时进程实例，**进程一换就自动换新 id**，并提示你上下文已重置。
- 重载 Obsidian、重启运行时、崩溃自动重连之后，**上下文都会重置**，但**对话记录会保留**供你阅读。
- 想继续同一个话题，请在同一段运行时生命周期内接着聊，不要中途重启。

> 这是与 Web GUI 的一个真实差异：Web GUI 能从磁盘恢复历史会话，SDK 协议目前给不了这个能力。

---

## 需要说清楚的取舍

**iframe 方案在功能完整度上更强**，因为它面板里跑的就是完整的 DSH Web UI：审批交互、取消单轮、
流式输出、以及 DSH 将来新增的任何前端功能都天然具备。

本插件受限于 SDK 协议暴露的能力，**没有**以下功能（详见[已知限制](#已知限制)）：

- 无法应答审批弹窗（协议没有服务端→客户端请求）
- 无法取消单轮（协议没有取消方法，「停止」只能关进程）
- 没有实时流式输出（协议不转发 `AssistantStreamFrame` 增量帧流）

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

两个关键设计点：

- **`initialize` 的 `cwd` 就是 agent 的工作区根目录**（即 `session.header.cwd`）。默认设为 vault 根目录，因此 agent 直接在你的笔记上工作。
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
3. 在插件设置里点「开始检测」体检，再点「测试连接」
   看到「连接成功：deepseek-harness-sdk-runtime v0.0.1（3701ms）」即链路打通

---

## 用法

### 打开面板

点左侧栏的机器人图标，或运行命令 **`DSH Native: 打开对话面板`**。面板开在右侧边栏。

### 开始对话

直接在输入框里提问，**Enter 发送，Shift+Enter 换行**。首次发送会自动启动运行时（第一次可能要等十几秒到几十秒，
因为 DSH 要从随附模板自举 `sdk` profile）。

agent 的工作目录就是你的 vault，所以你可以直接说「把 `灵茶山艾府/位运算.md` 里的第二节改写成表格」这类话。

### 框选一段笔记交给 agent

1. 在笔记里选中一段文字
2. 命令面板运行 **`DSH Native: 把选中内容发给 DSH`**
3. 默认会把「文件 + 行:列 + 字数」的引用插入输入框（**不会覆盖你已输入的文字**），你补一句要求后回车

也可以把设置里的「框选后」改成**直接发送**，省掉第三步。

### 把回复存进笔记

点面板头部的 **存入笔记**：把最后一条助手回复追加到当前活动笔记；如果没有活动笔记，则复制到剪贴板。

### 跳到 agent 提到的文件

回复里出现的 vault 路径是可点的。带行号的（如 `notes/a.md:120`）会直接跳到那一行。

### 出问题时

- 面板里的**错误卡片**会告诉你是什么问题、怎么修，并给出按钮。
- 设置页点 **开始检测** 做一次环境体检。
- 设置页的 **诊断** 区能复制出全部解析结果与最近握手信息。
- 头部 **重启** 可以重新拉起运行时；**停止** 会关掉进程（协议不支持取消单轮，只能这样）。

### 设置项

| 分组 | 设置 | 默认 | 说明 |
|---|---|---|---|
| 界面 | 界面语言 | 跟随 Obsidian | 跟随 Obsidian / 中文 / English；改完立即生效 |
| 环境 | 检测环境 | 按钮 | 逐项体检并给出修复建议 |
| 环境 | dsh CLI 产物（bin.js） | 自动探测 | 指向 `<仓库>/apps/cli/lib/bin.js` |
| 环境 | node 可执行文件 | 自动探测 | 留空回退为 PATH 上的 `node` |
| 环境 | 工作区目录（cwd） | vault 根目录 | 作为 `initialize` 的 cwd；沙箱把写入限制在此目录内 |
| 环境 | DSH_HOME | `~/.dsh` | 仅当配置目录不在默认位置时填 |
| 环境 | profile | `sdk` | 一般不用改 |
| 连接 | provider / model | `deepseek-official` / `deepseek-v4-flash-vision-exp` | 握手时由适配器校验路由 |
| 连接 | reasoning effort | `high` | 留空用模型默认值 |
| 连接 | max tokens | `0` | 0 = 模型默认值 |
| 连接 | 测试连接 | 按钮 | 跑一次 initialize 握手 |
| 交互 | 框选发送的内容 | 只发文件位置引用 | 见上文三种模式 |
| 交互 | 框选后 | 插入输入框，等我编辑 | 或直接发送 |
| 交互 | 显示工具调用 | 开 | 🔧 工具活动行 |
| 交互 | 笔记路径可点击 | 开 | 回复里的 vault 路径变链接 |
| 交互 | 崩溃后自动重连 | 开 | 最多 3 次指数退避 |

---

## 已验证的行为

开发时用真实 CLI 实测（非推断）：

| 验证 | 结果 |
|---|---|
| `initialize` 握手（全新 `DSH_HOME` 自举 `sdk` profile） | ✅ 3.7 秒，返回 `deepseek-harness-sdk-runtime v0.0.1` |
| 完整一轮对话 | ✅ `running` → `assistant/message` → `turn/end {kind:"completed"}`，文本正确提取 |
| 进程内多轮上下文 | ✅ 第一轮记住 42，第二轮复用同一 `sessionId` 答出 `42` |
| 跨进程复用旧 `sessionId` | ❌ 如预期被拒 `already exists`（因此插件会换新 id） |
| 跨进程换新 `sessionId` | ✅ 正常开始新会话 |

`dev/test-logic.cjs` 另有 30 项纯逻辑回归测试（i18n 完整性、错误翻译、选区构造、本轮结束判定、渲染与记录分工），
不联网、不调用模型，可随时跑。

测试在开发过程中抓出并修掉了三个真实 bug：

1. `turn/end` 的 `reason` 是**对象** `{kind:'completed'}` 而不是字符串，早期实现会让每轮成功都误报「本轮结束」。
2. `explainError` 里匹配「未找到 dsh CLI 产物」时大小写不匹配，导致该分支**永远不命中**，用户拿到没用的通用卡片。
3. `appendNotice` → 记录 → 渲染 → 又调回 `appendNotice`，形成**双重渲染：面板里每条消息都会出现两次**。

## 已知限制

这些是**协议本身的边界**，不是插件的缺陷：

1. **无法取消单轮**。协议层没有取消方法，「停止」只能关掉整个运行时进程；下一轮发送时会自动重启。
2. **无法应答审批弹窗**。协议没有服务端→客户端请求，SDK 模式下审批无处可答。工作区内的写入本来就无需审批；一旦某操作需要提权，它会 **fail closed（直接失败）**——这是安全的一侧。
3. **没有实时流式输出**。agent-loop 的增量发在 `AssistantStreamFrame` 通道上，而 SDK 服务端只转发会话级通知，不转发这个帧流。助手消息只能在每个 step 结束时整段呈现。
4. **上下文不能跨进程续接**。见[会话与上下文](#会话与上下文重要)。
5. **一次一轮**。面板在等待本轮结束时不允许再发送；即使发了，运行时也会把它当 followup 排队。
6. **子 agent 只显示一行提示**，没有把子会话事件并进主面板。
7. `stderr` 上的 `dsh: reasoning:` 推理增量被刻意过滤，不逐条铺进面板。

## 安全说明

- 沙箱由 DSH 提供，不是本插件：base 系 profile 默认使用 **`workspace-write`** 权限预设，**写入被限制在会话工作区（默认 vault）与平台临时目录内**；读和网络不受限。
- 因此把工作区目录改成 vault 之外的位置，就等于让 agent 能写那些位置。**建议保持默认。**
- 插件把 DSH 子进程的环境继承自 Obsidian 进程，额外只加你填的 `DSH_HOME`。
- 插件**不读取、不转发**任何密钥：环境检测只判断凭据文件是否存在，不读取其内容。
- 插件自身不发起任何网络请求，也不含遥测。

## 开发

源码就是 `main.js` 一个文件，含四部分：

| 部分 | 作用 |
|---|---|
| `DshRuntime` | JSON-RPC 客户端：spawn 子进程、分帧、请求/响应、通知分发、关闭阶梯（stdin EOF → SIGTERM → SIGKILL） |
| `DshView` | 对话面板：消息渲染与记录、本轮结束判定、错误卡片、路径链接化、重连 |
| `explainError` / `checkEnvironment` / `buildSelectionPayload` | 纯函数：错误翻译、环境检测、选区上下文构造 |
| `DICT` / `t()` / `setLanguage` | 文案字典与取词：中英各一套，跟随 Obsidian 语言或手动覆盖 |
| `DshSettingTab` / `DshPlugin` | 设置页与插件入口 |

没有构建步骤：改完 `main.js` 直接在 Obsidian 里重载插件（`Ctrl+R`）即可。

测试脚本在 [`dev/`](dev/)，见 [`dev/README.md`](dev/README.md)：

```sh
node dev/test-logic.cjs           # 纯逻辑回归测试，不联网
node dev/probe-session-resume.cjs # 协议探针，会真实调用模型
```

`main.js` 末尾额外导出了内部符号供这些脚本复用（不影响 Obsidian 把 `module.exports` 当插件类加载）。

本轮结束的判定值得注意：必须先在 `session.status` 上观察到 `running`，之后收到 `turn/end`
或 `running → idle` 才算结束。要求「见过 running」是为了排除上一轮遗留的 `idle` 把本轮提前判定为完成。

## 相关

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— DSH 本体
- [Obsidian 插件开发文档](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)

## License

[MIT](LICENSE)
