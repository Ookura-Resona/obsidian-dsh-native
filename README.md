# DSH Native

在 Obsidian 里以原生面板运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

它把 DSH 的 `sdk` profile 作为子进程启动，通过 DSH 官方的 SDK 协议（stdio 上的 JSON-RPC）通信，
不加载网页，也不修改你的 DSH 安装。对话界面是 Obsidian 自己的面板，跟随你的主题和字体。

## 工作原理

插件启动：

```
node <你的 dsh 仓库>/apps/cli/lib/bin.js --profile sdk
```

然后按 [`@deepseek-ai/dsh-sdk-protocol`](https://github.com/deepseek-ai/deepseek-harness) 的规定，
用换行分帧的 JSON-RPC 2.0 在 stdin/stdout 上驱动它。协议面很小：

| 方向 | 方法 |
|---|---|
| 客户端 → 服务端 | `initialize` / `session/prompt` / `shutdown` |
| 服务端 → 客户端 | `session.event` / `session.status` / `subagent.started` / `subagent.finished` |

两点需要说明：

- `initialize` 的 `cwd` 就是 agent 的工作区根目录。插件默认把它设为 vault 根目录，所以 agent 可以直接读写笔记。
- 因为协议很小，插件自己实现了这层客户端，`main.js` 是单个 CommonJS 文件，没有构建步骤，也没有运行时依赖。

## 环境要求

| 项 | 要求 |
|---|---|
| Obsidian | 桌面版（插件声明了 `isDesktopOnly`，因为要用 Node 的 `child_process`） |
| Node.js | 需要能在 Obsidian 的子进程里调用到；建议在设置里填绝对路径 |
| DSH | 一份**已经构建好**的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库，即 `apps/cli/lib/bin.js` 存在 |
| 凭据 | DSH 自己的凭据解析（`$DSH_HOME/.credentials.yaml`、环境变量或 `.env`）。插件不读取也不转发密钥 |

`$DSH_HOME` 默认是 `~/.dsh`，与 dsh 命令行一致。只有配置目录不在默认位置时才需要填。

## 安装

### BRAT

用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 添加 `Ookura-Resona/obsidian-dsh-native`。

### 手动

1. 把 `main.js`、`manifest.json`、`styles.css` 放进 `<你的 vault>/.obsidian/plugins/dsh-native/`
2. 打开 设置 → 第三方插件，关闭「受限模式」，在「已安装插件」里启用 **DSH Native**
3. 到插件设置里点「开始检测」检查环境，再点「测试连接」
   连接成功会提示 `deepseek-harness-sdk-runtime v0.0.1` 以及握手耗时

### dsh 装在哪里都能用

插件不假定 dsh 的位置，也不关心你的仓库叫什么名字。它会按下面的顺序自动探测启动器：

| 顺序 | 位置 |
|---|---|
| 1 | `<家目录>/deepseek-harness/apps/cli/lib/bin.js`（git 检出。另外也试 `code/` 与 `projects/` 两个常见目录） |
| 2 | npm 全局安装：Windows 在 `<家目录>/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`；macOS / Linux 在 `/usr/local/lib/node_modules/`、`/usr/lib/node_modules/`、`/opt/homebrew/lib/node_modules/` 下 |

都不匹配时，在设置里把「dsh CLI 产物」填成绝对路径即可——仓库放在哪里、叫什么名字都行。
点「自动探测」会重新找一遍，「开始检测」会逐项说明缺什么。

node 也是同样的处理：先找几个常见安装位置，找不到就回退到 PATH 上的 `node`，
所以使用 nvm、fnm 这类版本管理器也没问题。

换句话说，插件里没有任何写死的机器路径或用户名；除 `node` 与 dsh 之外，它不需要别的工具。

## 使用

### 打开面板

点左侧栏的机器人图标，或运行命令 `DSH Native: 打开对话面板`。面板会开在右侧边栏。

### 对话

在输入框里提问，Enter 发送，Shift+Enter 换行。第一次发送会自动启动 dsh 运行时，
首次启动需要初始化 `sdk` profile，可能要等十几秒到几十秒。

agent 的工作目录就是你的 vault，所以可以直接说「把 `灵茶山艾府/位运算.md` 的第二节改写成表格」这类话。

### 发送选中的内容

在笔记里选中一段文字，运行命令 `DSH Native: 把选中内容发给 DSH`。默认会把这样一行插入输入框：

```
[选中片段] 文件：notes/a.md｜范围：第 12 行第 3 列 → 第 15 行第 8 列（共 87 字符）｜请读取该文件对应范围后处理
```

它只给出位置，让 agent 自己去读文件。相比直接贴原文，这样更省 token，也能处理只选中半行的情况。
插入时不会覆盖你已经在输入框里写的内容。

设置里可以改成只发原文、或者两者都发；也可以让它在选中后直接发送，不用再按一次回车。

### 其他操作

- 点面板头部的「存入笔记」，把最后一条回复追加到当前笔记；没有打开笔记时会复制到剪贴板。
- 回复里出现的 vault 路径可以直接点开。写成 `notes/a.md:120` 的话，会跳到第 120 行。
- 点「重启」重新拉起运行时；点「停止」关掉它（协议没有取消单轮的方法，只能关进程）。

### 出错时

面板会显示一张错误卡片，写明是什么问题、怎么处理，并给出可以点的按钮。覆盖的情况包括：
找不到 node、dsh 没有构建、provider 名写错、握手超时、运行时崩溃、凭据有问题、权限被拒、会话 id 冲突。

设置页里还有两处可以自查：「开始检测」逐项检查环境，包括 dsh 版本和构建产物是否落后于源码；
「诊断」区显示各项解析结果和最近一次握手记录，可以一键复制出来。

### 设置

| 分组 | 设置 | 默认 | 说明 |
|---|---|---|---|
| 界面 | 界面语言 | 跟随 Obsidian | 跟随 Obsidian / 中文 / English，改完立即生效 |
| 环境 | 检测环境 | 按钮 | 逐项检查并给出修改建议 |
| 环境 | dsh CLI 产物（bin.js） | 自动探测 | 指向 `<仓库>/apps/cli/lib/bin.js` |
| 环境 | node 可执行文件 | 自动探测 | 留空时回退为 PATH 上的 `node` |
| 环境 | 工作区目录（cwd） | vault 根目录 | 作为 `initialize` 的 cwd，沙箱把写入限制在这个目录内 |
| 环境 | DSH_HOME | `~/.dsh` | 配置目录不在默认位置时才需要填 |
| 环境 | profile | `sdk` | 一般不用改 |
| 连接 | provider / model | 留空（跟随 DSH） | 留空时用 DSH 自己设置的默认模型；两者需要成对填写 |
| 连接 | reasoning effort | 留空（跟随 DSH） | 留空时用 DSH 设置里的值 |
| 连接 | max tokens | `0` | 0 表示用模型默认值 |
| 连接 | 重新读取 DSH 设置 | 按钮 | 在 DSH 界面改过默认模型后刷新上面的取值 |
| 连接 | 测试连接 | 按钮 | 跑一次 `initialize` 握手 |
| 交互 | 框选发送的内容 | 只发文件位置引用 | 另有「只发原文」「引用 + 原文」 |
| 交互 | 框选后 | 插入输入框，等我编辑 | 或直接发送 |
| 交互 | 显示工具调用 | 开 | 显示 🔧 工具名等活动行 |
| 交互 | 笔记路径可点击 | 开 | 回复里的 vault 路径变成链接 |
| 交互 | 崩溃后自动重连 | 开 | 最多重试 3 次，间隔 1s / 2s / 4s |

## 模型从哪来

插件不自己存一份模型设置。`provider` 和 `model` 默认留空，这时它会去读 DSH 的设置文档：

```
$DSH_HOME/settings.yaml
  agent-default-model:
    provider: ...
    model: ...
    reasoningEffort: ...
```

也就是说，**你在 DSH 的界面里改了默认模型，插件也会跟着改**。面板每次启动运行时都重新读一遍，
所以在 DSH 里改完，回面板点「重启」就生效。

优先级：

1. 插件设置里 provider 与 model **都**填了 —— 用插件的
2. 否则 DSH 设置文档里有 —— 用 DSH 的
3. 都没有 —— 用插件内置的兜底值，DSH 更新后可能失效，设置页会标出来

provider 与 model 必须成对，只填一个不算覆盖，设置页会给出提示。`reasoning effort` 可以单独覆盖。

设置页「连接与模型路由」顶部会显示当前生效的组合和它的来源，命令行下可以用
`node dev/probe-route.cjs` 查看。

## 更新 DSH 之后

插件只依赖 SDK 协议，所以 DSH 改前端、加界面功能都不会影响它。真正需要注意的是两件事。

**1. 插件跑的是构建产物。**

如果 dsh 是从 git 检出装的，插件启动的是 `apps/cli/lib/bin.js`，那是 `pnpm run build` 的产物。
只 `git pull` 而不重新构建的话，插件会继续跑旧代码，而且不会报错。

```sh
cd <你的 dsh 仓库>
git pull
pnpm install
pnpm run build      # 这一步不能省
```

设置页的环境检测里有一项专门查这个：比较 `apps/cli/src` 与 `lib/bin.js` 的修改时间，
产物落后就会提示重新构建。

**2. 模型设置会自动跟上。** 见上一节。DSH 那边改了默认模型，插件重启运行时就会读新的。

如果 dsh 是用 npm 装的（`npm i -g @deepseek-ai/dsh`），更新就是一条命令，不需要构建：

```sh
npm i -g @deepseek-ai/dsh@latest
```

自动探测会去找 npm 全局目录下的 `@deepseek-ai/dsh/lib/bin.js`，所以不用手动填路径。

**刷新时机**：插件不是常驻绑定 DSH 的，而是每次启动运行时新起一个进程。所以改完 dsh 之后回面板点「重启」即可，
不需要重装插件，也不需要重启 Obsidian。诊断区会显示当前探测到的 dsh 版本，可以用来确认实际在跑哪一版。

## 会话与上下文

这一点值得单独说明，因为它是 SDK 协议的限制，实测确认（见 [`dev/probe-session-resume.cjs`](dev/probe-session-resume.cjs)）：

| 场景 | 结果 |
|---|---|
| 在同一个运行时进程内继续对话 | 可以，上下文延续 |
| 运行时进程重启后复用原来的会话 id | 服务端拒绝：`[-32603] session "<id>" already exists` |
| 重启后换一个新的会话 id | 可以，但上下文是空的 |

原因是 SDK 服务端只会调用 `agents.create`，而会话已经落盘，同名创建会被拒绝；协议里没有恢复会话的入口。

所以：

- 插件把会话 id 跟运行时进程绑定，进程一换就换新 id，并提示你上下文已重置。
- 重载 Obsidian、重启运行时、崩溃自动重连之后，上下文都会丢失，但对话记录会保留下来给你看。
- 想接着同一个话题聊，就不要中途重启。

DSH 的 Web GUI 可以从磁盘恢复历史会话，SDK 协议目前做不到。

## 已知限制

1. **不能取消单轮**。协议里没有取消方法，「停止」只能关掉整个运行时进程，下一次发送会自动重启。
2. **不能应答审批弹窗**。协议没有服务端到客户端的请求，审批没有地方回应。工作区内的写入本来就不需要审批；需要提权的操作会直接失败。
3. **没有流式输出**。agent-loop 把增量发在 `AssistantStreamFrame` 通道上，而 SDK 服务端只转发会话级通知，不转发这个帧流。助手消息在每个 step 结束时整段出现。
4. **上下文不能跨进程续接**，见上一节。
5. **一次只能跑一轮**。等待本轮结束时面板不接受新的发送；即使发了，运行时也会把它当作后续消息排队。
6. **子 agent 只显示一行提示**，子会话的事件没有并进主面板。
7. stderr 上的 `dsh: reasoning:` 推理内容被过滤掉了，没有逐条显示。

## 与其他 DSH 插件的区别

Obsidian 社区里已经有一些嵌入 DSH Web UI 的插件：它们用 iframe 加载 `dsh web` 的页面，
再往页面里注入脚本来实现笔记和对话之间的联动。本插件是另一条路——直接驱动 SDK 协议，
不加载网页，也不改动 DSH 的配置文件。

| | 本插件 | 嵌入 Web UI 的插件 |
|---|---|---|
| 界面 | Obsidian 原生面板，跟随主题 | DSH Web UI |
| 通信方式 | stdio 上的 JSON-RPC | localhost HTTP |
| 与 DSH 前端的耦合 | 无 | 依赖页面 DOM 和 React 内部实现，需要跟随 DSH 版本更新 |
| 功能完整度 | 受 SDK 协议限制（见「已知限制」） | 完整，包括审批交互和流式输出 |

需要完整的 DSH 界面就用嵌入 Web UI 的插件；只需要一个跟随主题、不受 DSH 前端改版影响的对话面板，
可以用这个。

## 安全

- 沙箱由 DSH 提供，不是插件实现的。基于 base 的 profile 默认使用 `workspace-write` 权限预设，
  写入被限制在会话工作区和平台临时目录内，读取和网络不受限。
- 如果把工作区目录改成 vault 之外的位置，agent 就能写那些位置。建议保持默认。
- 插件把 dsh 子进程的环境继承自 Obsidian 进程，额外只加上你填的 `DSH_HOME`。
- 环境检测只判断凭据文件是否存在，不读取内容。插件自身不发起网络请求，也没有遥测。

## 开发

`main.js` 是单个文件，主要包含四部分：

| 部分 | 作用 |
|---|---|
| `DshRuntime` | JSON-RPC 客户端：启动子进程、分帧、请求与响应、通知分发、关闭流程 |
| `DshView` | 对话面板：消息的渲染与记录、本轮结束判定、错误卡片、路径链接化、重连 |
| `explainError` / `checkEnvironment` / `buildSelectionPayload` | 纯函数：错误翻译、环境检测、选区内容构造 |
| `resolveRoute` / `readDshDefaultModel` | 模型路由解析：判断用插件设置、DSH 设置还是内置兜底 |
| `DICT` / `t()` | 界面文案，中英各一套 |
| `DshSettingTab` / `DshPlugin` | 设置页和插件入口 |

改完直接在 Obsidian 里按 `Ctrl+R` 重载即可，没有构建步骤。

测试脚本放在 [`dev/`](dev/)，用法见 [`dev/README.md`](dev/README.md)：

```sh
node dev/test-logic.cjs           # 43 项逻辑测试，不联网
node dev/probe-route.cjs          # 看这次会用哪个模型，不联网
node dev/probe-session-resume.cjs # 协议探针，会真实调用模型
```

`main.js` 末尾导出了一些内部符号供这些脚本复用，不影响 Obsidian 把 `module.exports` 当作插件类加载。

关于本轮结束的判定：必须先在 `session.status` 上看到 `running`，之后收到 `turn/end` 或 `running → idle`
才算结束。要求「见过 running」是为了避免上一轮残留的 `idle` 把本轮提前判定为完成。

## 许可

[MIT](LICENSE)
