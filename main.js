/*
 * dsh-native — 在 Obsidian 里以原生面板驱动 DeepSeek Harness。
 *
 * 与「用 iframe 嵌 DSH 网页」那类方案的根本区别：本插件不注入网页、不修改
 * DSH 安装、不依赖它的前端 DOM，只走官方 SDK 协议，因此 DSH 升级前端也不易失效。
 *
 * 工作原理
 * --------
 * 以子进程方式启动 dsh 运行时的 `sdk` profile：
 *
 *     node <checkout>/apps/cli/lib/bin.js --profile sdk
 *
 * 并按 @deepseek-ai/dsh-sdk-protocol 的规定，用「换行分帧的 JSON-RPC 2.0」
 * 在 stdin/stdout 上驱动它。协议面很小：
 *
 *   客户端 -> 服务端 : initialize / session/prompt / shutdown
 *   服务端 -> 客户端 : session.event / session.status /
 *                      subagent.started / subagent.finished
 *
 * `initialize` 的 `cwd` 就是 agent 的工作区根目录（session.header.cwd）。
 * 因此本插件默认把它设为 vault 根目录：base 系 profile 默认使用
 * `workspace-write` 权限预设，agent 可以直接读写你的笔记，而沙箱把写入
 * 限制在 vault 与平台临时目录内。
 *
 * 会话 id 的生命周期（实测结论，很重要）
 * -------------------------------------
 * 1. 同一个运行时进程内复用同一 sessionId = 接着同一上下文继续（多轮成立）。
 * 2. 进程重启后**不能**复用旧 sessionId：服务端只走 `agents.create`，而会话
 *    已持久化到磁盘，create 会拒绝 —— `[-32603] session "<id>" already exists`。
 * 3. 所以 sessionId 必须绑定到「运行时进程实例」，进程一换就换新 id。
 *    （见 dev/probe-session-resume.cjs）
 *
 * 国际化
 * ------
 * 界面文案走 DICT + t()，跟随 Obsidian 语言，可在设置里手动覆盖为中文/英文。
 * 自己抛出的错误带 `code`（如 DSH_NO_CLI），因此错误匹配不依赖界面语言；
 * 服务端返回的错误（英文）仍按正则匹配。见 dev/test-i18n 相关断言。
 *
 * 已知限制（协议本身的边界，不是本插件的 bug）
 * -------------------------------------------
 * 1. 协议层没有「取消本轮」方法 —— 「停止」只能关掉整个运行时进程。
 * 2. 协议层没有客户端/服务端反向请求，因此无法应答审批弹窗。工作区内的
 *    写入本来就无需审批；一旦某操作需要提权，它会 fail closed。
 * 3. 没有实时流式增量：agent-loop 把增量发在 `AssistantStreamFrame` 通道上，
 *    而 SDK 服务端只转发 `session.event` / `session.status` 等会话级通知，
 *    不转发这个帧流。因此助手消息只能在每个 step 结束时整段呈现。
 */

'use strict'

const obsidian = require('obsidian')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')

const {
  Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownRenderer, MarkdownView,
} = obsidian

const VIEW_TYPE = 'dsh-native-view'

/** 一轮对话的兜底等待上限（毫秒）。 */
const TURN_TIMEOUT_MS = 30 * 60 * 1000

/** 启动 + initialize 握手的等待上限（毫秒）：首次会初始化 profile，给足时间。 */
const INIT_TIMEOUT_MS = 3 * 60 * 1000

/** 面板保留的历史消息条数上限（同时用于持久化）。 */
const MAX_TRANSCRIPT = 200

/** 单条消息持久化时的字符上限，避免 data.json 膨胀。 */
const MAX_ENTRY_CHARS = 20000

/** 崩溃后自动重连的最大次数。 */
const MAX_RECONNECT = 3

/** 自己抛出的错误使用的稳定 code（不随界面语言变化）。 */
const ERR = {
  noCli: 'DSH_NO_CLI',
  notRunning: 'DSH_NOT_RUNNING',
  timeout: 'DSH_TIMEOUT',
  exited: 'DSH_RUNTIME_EXITED',
  stopped: 'DSH_STOPPED',
  spawnFailed: 'DSH_SPAWN_FAILED',
}

/**
 * 常见 CLI 产物位置，用于「自动探测」。
 * 一律相对于家目录拼，避免把某台机器的绝对路径硬编码进来。
 */
const CLI_CANDIDATES = [
  path.join(os.homedir(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
  path.join(os.homedir(), 'code', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
  path.join(os.homedir(), 'projects', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'),
  path.join(os.homedir(), '.dsh', 'bin', 'bin.js'),
]

/** 常见 node 可执行文件位置，用于「自动探测」。 */
const NODE_CANDIDATES = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node.exe'),
  '/usr/local/bin/node',
  '/usr/bin/node',
  '/opt/homebrew/bin/node',
]

const DEFAULT_SETTINGS = {
  // 'auto' | 'zh' | 'en'
  language: 'auto',
  nodePath: '',
  cliPath: '',
  dshHome: '',
  profile: 'sdk',
  cwd: '',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash-vision-exp',
  reasoningEffort: 'high',
  maxTokens: 0,
  showToolActivity: true,
  // 选中内容的发送方式：reference=只发文件位置引用；text=只发原文；both=两者
  selectionMode: 'reference',
  // 框选后：insert=插入输入框等待编辑；send=直接发送
  selectionAction: 'insert',
  autoReconnect: true,
  linkifyPaths: true,
  lastHandshake: null,
  transcript: null,
}

/* ------------------------------------------------------------------ *
 * 国际化
 * ------------------------------------------------------------------ */

/** 文案字典。zh 与 en 的 key 集合必须完全一致（有测试兜底）。 */
const DICT = {
  zh: {
    // ---- 面板 ----
    'panel.newSession': '新会话',
    'panel.restart': '重启',
    'panel.insertIntoNote': '存入笔记',
    'panel.stop': '停止',
    'panel.send': '发送',
    'panel.inputPlaceholder': '问点什么，或让 agent 直接改你的笔记…（Enter 发送，Shift+Enter 换行）',
    'panel.workspaceHint': '工作区：{path}',
    'panel.status.disconnected': '未连接',
    'panel.status.starting': '正在启动 dsh 运行时…',
    'panel.status.connected': '已连接 {name}',
    'panel.status.running': '运行中…',
    'panel.status.ready': '就绪',
    'panel.status.readyNewSession': '就绪（新会话）',
    'panel.status.error': '出错',
    'panel.status.stopped': '已停止',
    'panel.status.restarting': '正在重启…',
    'panel.status.restartFailed': '重启失败',
    'panel.status.exited': '运行时已退出（code={code}）',
    'panel.empty.line1': 'DSH Native 尚未连接。',
    'panel.empty.line2': '直接输入问题并按 Enter，插件会自动启动运行时。',
    'panel.empty.line3': 'agent 以 vault 为工作目录，可直接读写笔记。',
    'panel.restored': '已恢复上次的对话记录。DSH 协议不支持跨进程续接上下文，请直接提新问题或点「新会话」。',
    'panel.runtimeRestarted': '运行时已重启：已自动开启新会话（DSH 协议不支持跨进程续接上下文）',
    'panel.openPanelCommand': '打开对话面板',
    'panel.sendSelectionCommand': '把选中内容发给 DSH',

    // ---- 动作按钮 ----
    'action.retry': '重试',
    'action.settings': '打开设置',
    'action.check': '检测环境',
    'action.restart': '重启运行时',
    'action.newSession': '开新会话',

    // ---- 错误卡片 ----
    'err.sessionExists.title': '会话 id 已被占用',
    'err.sessionExists.hint1': '这通常发生在运行时进程重启后复用了旧会话 id —— DSH 协议不支持跨进程续接会话。',
    'err.sessionExists.hint2': '插件已经会自动换一个新会话 id 重试；若仍失败，点下面的「开新会话」。',
    'err.noNode.title': '找不到 node 可执行文件',
    'err.noNode.hint1': '在设置里把「node 可执行文件」填成绝对路径，例如 C:\\Program Files\\nodejs\\node.exe',
    'err.noNode.hint2': '确认 Node.js 已安装，且路径没有写错。',
    'err.noCli.title': '没找到 dsh 的构建产物（bin.js）',
    'err.noCli.hint1': '在 deepseek-harness 仓库里执行 pnpm install 然后 pnpm run build。',
    'err.noCli.hint2': '然后在设置里把「dsh CLI 产物」指向 apps/cli/lib/bin.js。',
    'err.provider.title': 'provider 名称不被识别',
    'err.provider.hint1': 'provider 必须与 DSH 已注册的适配器一致；deepseek-official 内置可用。',
    'err.provider.hint2': '检查设置里的 provider / model 拼写。',
    'err.initTimeout.title': 'initialize 握手超时',
    'err.initTimeout.hint1': '首次使用 sdk profile 时 DSH 要从随附模板自举，可能需要几十秒到几分钟。',
    'err.initTimeout.hint2': '也可能是同时在启动多个实例；稍等后重试或重启运行时。',
    'err.runtimeExited.title': 'dsh 运行时进程退出了',
    'err.runtimeExited.hint1': '进程可能因为配置错误或环境问题崩溃。',
    'err.runtimeExited.hint2': '点「重启运行时」可以重新拉起；开了自动重连时插件也会自己重试。',
    'err.credentials.title': '凭据相关问题',
    'err.credentials.hint1': 'DSH 的凭据从环境变量、$DSH_HOME/.credentials.yaml 或 .env 解析。',
    'err.credentials.hint2': '确认已配置可用的 API key；插件本身不读取也不转发密钥。',
    'err.permission.title': '权限被拒绝',
    'err.permission.hint1': '检查 node 与 dsh 仓库目录的读取权限。',
    'err.permission.hint2': 'Windows 上若仓库位于受保护目录，可能被系统策略拦下。',
    'err.generic.title': '出错了',
    'err.generic.detailFallback': '（没有更多信息）',
    'err.generic.hint1': '可以点「检测环境」看各项配置是否正常，或「重启运行时」重来一次。',

    // ---- 自己抛出的错误文案 ----
    'raised.noCli': '未找到 dsh CLI 产物。请在插件设置里填写 bin.js 的绝对路径。',
    'raised.notRunning': 'dsh 运行时未运行',
    'raised.timeout': '{method} 超时（{ms}ms）',
    'raised.spawnFailed': '无法启动 dsh 子进程：{message}',
    'raised.exited': 'dsh 运行时已退出（code={code}, signal={signal}）',
    'raised.stopped': 'dsh 运行时已被用户停止',
    'raised.serverUnknownError': '未知错误',

    // ---- 环境检测 ----
    'env.node': 'Node.js',
    'env.node.ok': '{path} -> {version}',
    'env.node.fail': '{path} 无法执行：{message}',
    'env.node.fix': '在设置里把「node 可执行文件」填成绝对路径，例如 C:\\Program Files\\nodejs\\node.exe',
    'env.cli': 'dsh CLI 产物',
    'env.cli.missing': '未找到 bin.js',
    'env.cli.notFoundFile': '文件不存在：{path}',
    'env.cli.fix': '在 deepseek-harness 仓库里执行 pnpm install 与 pnpm run build，然后在设置里指定 apps/cli/lib/bin.js',
    'env.workspace': '工作区目录',
    'env.workspace.notDir': '这个路径不是目录',
    'env.workspace.missing': '不存在：{path}',
    'env.workspace.fix': '在设置里改成存在的目录，或留空使用 vault 根目录',
    'env.home': 'DSH_HOME',
    'env.home.missing': '尚不存在：{path}',
    'env.home.fix': '首次启动 sdk profile 时 DSH 会自动创建，无需手动处理',
    'env.profile': 'profile「{name}」',
    'env.profile.missing': '尚未初始化：{path}',
    'env.profile.fix': '首次启动会自动从随附模板初始化，可能耗时几十秒',
    'env.cred': '模型凭据',
    'env.cred.env': '检测到环境变量 DEEPSEEK_API_KEY（插件不读取其值）',
    'env.cred.file': '存在 {path}（插件不读取其内容）',
    'env.cred.missing': '未在环境变量或 {path} 里发现凭据',
    'env.cred.fix': '按 DSH 的凭据方式配置 API key（插件本身不接触密钥）',
    'env.summary.ok': '全部正常。',
    'env.summary.warn': '{count} 项需要留意（多数首次启动会自动解决）。',
    'env.summary.fail': '{count} 项失败，按上面的建议处理后重试。',
    'env.checkFailed': '检测失败：{message}',
    'env.report.ok': '环境检测：没有发现致命问题（详情见插件设置页）',
    'env.report.fail': '环境检测：{count} 项失败 —— {names}（详情见插件设置页）',

    // ---- 设置页 ----
    'set.topDesc': '插件以 sdk profile 启动 dsh 子进程，并用换行分帧的 JSON-RPC 驱动它。留空的路径项会自动探测。',
    'set.env.heading': '环境',
    'set.env.checkName': '检测环境',
    'set.env.checkDesc': '逐项检查 node、dsh 产物、工作区、DSH_HOME、profile 与凭据。只检测，不自动安装任何东西。',
    'set.env.checkBtn': '开始检测',
    'set.env.checking': '检测中…',
    'set.env.cliName': 'dsh CLI 产物（bin.js）',
    'set.env.cliDesc': '指向仓库里构建好的启动器，例如 <你的仓库>\\apps\\cli\\lib\\bin.js',
    'set.env.detectBtn': '自动探测',
    'set.env.detected': '已找到：{path}',
    'set.env.notDetected': '未在常见位置找到 bin.js，请手动填写',
    'set.env.nodeName': 'node 可执行文件',
    'set.env.nodeDesc': '留空则自动探测，仍找不到时回退为 PATH 上的 node。',
    'set.env.cwdName': '工作区目录（cwd）',
    'set.env.cwdDesc': '作为 initialize 的 cwd，也就是 agent 的工作区根目录。留空 = vault 根目录；写入被沙箱限制在此目录内。',
    'set.env.homeName': 'DSH_HOME',
    'set.env.homeDesc': '留空 = 沿用 dsh 默认值（~/.dsh）。仅当你的配置目录不在默认位置时才需要填写。',
    'set.conn.heading': '连接与模型路由',
    'set.conn.providerName': 'provider',
    'set.conn.providerDesc': '必须与 DSH 已注册的适配器一致；deepseek-official 内置可用。',
    'set.conn.modelName': 'model',
    'set.conn.modelDesc': '握手时会由适配器校验该路由；不可用会直接报错，不会静默回退。',
    'set.conn.effortName': 'reasoning effort',
    'set.conn.effortDesc': '可选，由适配器持有。留空则用模型默认值。',
    'set.conn.maxTokensName': 'max tokens',
    'set.conn.maxTokensDesc': '每次模型输出的上限；0 表示用模型默认值。',
    'set.conn.testName': '测试连接',
    'set.conn.testDesc': '启动一次运行时并完成 initialize 握手，用来验证上面的配置。',
    'set.conn.testBtn': '测试',
    'set.conn.testing': '测试中…',
    'set.conn.testOk': '连接成功：{name} v{version}（{ms}ms）',
    'set.conn.testFail': '连接失败：{title}',
    'set.interact.heading': '交互',
    'set.interact.selModeName': '框选发送的内容',
    'set.interact.selModeDesc': '命令「把选中内容发给 DSH」发什么。发送文件位置引用可让 agent 自己读文件，比贴原文更省 token，也能处理非整行选区。',
    'set.interact.selModeRef': '只发文件位置引用（推荐）',
    'set.interact.selModeText': '只发选中的原文',
    'set.interact.selModeBoth': '引用 + 原文',
    'set.interact.selActionName': '框选后',
    'set.interact.selActionDesc': '插入输入框可以让你先补一句要求再发送；直接发送更省事。',
    'set.interact.selActionInsert': '插入输入框，等我编辑',
    'set.interact.selActionSend': '直接发送',
    'set.interact.toolsName': '显示工具调用',
    'set.interact.toolsDesc': '在对话里显示 🔧 工具名等紧凑活动行。',
    'set.interact.linkName': '笔记路径可点击',
    'set.interact.linkDesc': '把回复里出现的 vault 内路径渲染成链接，点击直接在 Obsidian 打开（支持 path.md:行号 定位）。',
    'set.interact.reconnectName': '崩溃后自动重连',
    'set.interact.reconnectDesc': '运行时意外退出时自动重试，最多 {max} 次（指数退避）。注意：重连后上下文会重置 —— 协议不支持跨进程续接会话。',
    'set.lang.heading': '界面',
    'set.lang.name': '界面语言',
    'set.lang.desc': '跟随 Obsidian 使用其界面语言；也可以在这里强制指定。',
    'set.lang.auto': '跟随 Obsidian',
    'set.lang.zh': '中文',
    'set.lang.en': 'English',
    'set.diag.heading': '诊断',
    'set.diag.copyName': '复制诊断信息',
    'set.diag.copyDesc': '把上面的解析结果与最近一次握手记录复制到剪贴板，便于排查问题时贴出来。',
    'set.diag.copyBtn': '复制',
    'set.diag.copied': '已复制诊断信息',
    'set.diag.clearName': '清空面板记录',
    'set.diag.clearDesc': '面板会保留最近 {max} 条对话用于重载后查看（仅记录，不含上下文）。',
    'set.diag.clearBtn': '清空',
    'set.diag.cleared': '已清空面板记录',

    // ---- 诊断字段 ----
    'diag.version': '插件版本',
    'diag.node': 'node',
    'diag.cli': 'dsh CLI 产物',
    'diag.home': 'DSH_HOME',
    'diag.profile': 'profile',
    'diag.cwd': '工作区目录',
    'diag.route': 'provider / model',
    'diag.effort': 'reasoning effort',
    'diag.maxTokens': 'max tokens',
    'diag.lastHandshake': '最近一次握手',
    'diag.noHandshake': '（本机还没有记录）',
    'diag.handshakeOk': '成功 · {when}{ms}{server}',
    'diag.handshakeMs': ' · 耗时 {ms}ms',
    'diag.handshakeServer': ' · {name} v{version}',
    'diag.handshakeFail': '失败 · {when} · {error}',
    'diag.runtime': '面板运行时',
    'diag.running': '运行中',
    'diag.notRunning': '未运行',
    'diag.notFound': '（未找到）',
    'diag.modelDefault': '（模型默认）',

    // ---- 通知与杂项 ----
    'notice.noSelection': '没有选中内容',
    'notice.nothingToSave': '还没有可存入的回复',
    'notice.noActiveNote': '没有活动笔记，已复制到剪贴板',
    'notice.savedTo': '已存入 {name}',
    'notice.openSettingsManually': '请手动打开：设置 → 第三方插件 → DSH Native',
    'notice.sessionConflict': '会话 id 冲突，已自动换用新会话重试。',
    'notice.turnEnd': '本轮结束：{kind}{detail}',
    'notice.turnEndDetail': '（{detail}）',
    'notice.maxTokens': '达到输出上限',
    'notice.compacted': '上下文已压缩',
    'notice.subagentStarted': '↳ 子 agent 启动',
    'notice.reconnected': '已重连。',
    'notice.restarted': '运行时已重启。',
    'notice.reconnectIn': '{seconds} 秒后自动重连（第 {n}/{max} 次）…',
    'notice.reconnectGaveUp': '已连续重连 {max} 次仍未成功，请点「检测环境」排查。',
    'notice.error': '出错：{message}',
    'notice.toolCall': '🔧 {name} {args}',
    'notice.toolError': '✗ {detail}',
  },

  en: {
    // ---- Panel ----
    'panel.newSession': 'New session',
    'panel.restart': 'Restart',
    'panel.insertIntoNote': 'Save to note',
    'panel.stop': 'Stop',
    'panel.send': 'Send',
    'panel.inputPlaceholder': 'Ask something, or let the agent edit your notes… (Enter to send, Shift+Enter for a newline)',
    'panel.workspaceHint': 'Workspace: {path}',
    'panel.status.disconnected': 'Not connected',
    'panel.status.starting': 'Starting the dsh runtime…',
    'panel.status.connected': 'Connected to {name}',
    'panel.status.running': 'Running…',
    'panel.status.ready': 'Ready',
    'panel.status.readyNewSession': 'Ready (new session)',
    'panel.status.error': 'Error',
    'panel.status.stopped': 'Stopped',
    'panel.status.restarting': 'Restarting…',
    'panel.status.restartFailed': 'Restart failed',
    'panel.status.exited': 'Runtime exited (code={code})',
    'panel.empty.line1': 'DSH Native is not connected yet.',
    'panel.empty.line2': 'Type a question and press Enter — the plugin starts the runtime for you.',
    'panel.empty.line3': 'The agent uses your vault as its working directory and can read and write notes directly.',
    'panel.restored': 'Restored the previous transcript. The DSH protocol cannot resume context across processes, so ask a new question or click "New session".',
    'panel.runtimeRestarted': 'The runtime restarted, so a new session was started (the DSH protocol cannot resume context across processes)',
    'panel.openPanelCommand': 'Open chat panel',
    'panel.sendSelectionCommand': 'Send selection to DSH',

    // ---- Action buttons ----
    'action.retry': 'Retry',
    'action.settings': 'Open settings',
    'action.check': 'Check environment',
    'action.restart': 'Restart runtime',
    'action.newSession': 'New session',

    // ---- Error cards ----
    'err.sessionExists.title': 'Session id already in use',
    'err.sessionExists.hint1': 'This usually happens when an old session id is reused after the runtime process restarted — the DSH protocol cannot resume a session across processes.',
    'err.sessionExists.hint2': 'The plugin already retries with a fresh session id automatically; if it still fails, click "New session" below.',
    'err.noNode.title': 'node executable not found',
    'err.noNode.hint1': 'Set "node executable" in the settings to an absolute path, for example C:\\Program Files\\nodejs\\node.exe',
    'err.noNode.hint2': 'Make sure Node.js is installed and the path is spelled correctly.',
    'err.noCli.title': 'dsh build artifact (bin.js) not found',
    'err.noCli.hint1': 'In the deepseek-harness repository, run pnpm install and then pnpm run build.',
    'err.noCli.hint2': 'Then point "dsh CLI artifact" in the settings at apps/cli/lib/bin.js.',
    'err.provider.title': 'Provider name not recognized',
    'err.provider.hint1': 'The provider must match an adapter registered in DSH; deepseek-official is built in.',
    'err.provider.hint2': 'Check the provider / model spelling in the settings.',
    'err.initTimeout.title': 'initialize handshake timed out',
    'err.initTimeout.hint1': 'The first use of the sdk profile bootstraps it from a bundled template, which can take tens of seconds to a few minutes.',
    'err.initTimeout.hint2': 'It can also be several instances starting at once; wait a moment, then retry or restart the runtime.',
    'err.runtimeExited.title': 'The dsh runtime process exited',
    'err.runtimeExited.hint1': 'The process may have crashed because of a configuration or environment problem.',
    'err.runtimeExited.hint2': 'Click "Restart runtime" to bring it back; with auto-reconnect on, the plugin also retries by itself.',
    'err.credentials.title': 'Credential problem',
    'err.credentials.hint1': 'DSH resolves credentials from environment variables, $DSH_HOME/.credentials.yaml, or .env.',
    'err.credentials.hint2': 'Make sure a working API key is configured; the plugin never reads or forwards your keys.',
    'err.permission.title': 'Permission denied',
    'err.permission.hint1': 'Check read permissions on node and on the dsh repository directory.',
    'err.permission.hint2': 'On Windows, a repository inside a protected directory can be blocked by system policy.',
    'err.generic.title': 'Something went wrong',
    'err.generic.detailFallback': '(no further details)',
    'err.generic.hint1': 'Click "Check environment" to verify your configuration, or "Restart runtime" to start over.',

    // ---- Errors we raise ourselves ----
    'raised.noCli': 'dsh CLI artifact not found. Set the absolute path to bin.js in the plugin settings.',
    'raised.notRunning': 'The dsh runtime is not running',
    'raised.timeout': '{method} timed out ({ms}ms)',
    'raised.spawnFailed': 'Could not start the dsh subprocess: {message}',
    'raised.exited': 'The dsh runtime exited (code={code}, signal={signal})',
    'raised.stopped': 'The dsh runtime was stopped by the user',
    'raised.serverUnknownError': 'unknown error',

    // ---- Environment check ----
    'env.node': 'Node.js',
    'env.node.ok': '{path} -> {version}',
    'env.node.fail': 'Cannot execute {path}: {message}',
    'env.node.fix': 'Set "node executable" in the settings to an absolute path, for example C:\\Program Files\\nodejs\\node.exe',
    'env.cli': 'dsh CLI artifact',
    'env.cli.missing': 'bin.js not found',
    'env.cli.notFoundFile': 'File does not exist: {path}',
    'env.cli.fix': 'In the deepseek-harness repository run pnpm install and pnpm run build, then point the settings at apps/cli/lib/bin.js',
    'env.workspace': 'Workspace directory',
    'env.workspace.notDir': 'This path is not a directory',
    'env.workspace.missing': 'Does not exist: {path}',
    'env.workspace.fix': 'Change it to an existing directory in the settings, or leave it empty to use the vault root',
    'env.home': 'DSH_HOME',
    'env.home.missing': 'Does not exist yet: {path}',
    'env.home.fix': 'DSH creates it automatically on the first start of the sdk profile; nothing to do',
    'env.profile': 'profile "{name}"',
    'env.profile.missing': 'Not initialized yet: {path}',
    'env.profile.fix': 'It is initialized from the bundled template on first start, which can take tens of seconds',
    'env.cred': 'Model credentials',
    'env.cred.env': 'Found the DEEPSEEK_API_KEY environment variable (the plugin does not read its value)',
    'env.cred.file': 'Found {path} (the plugin does not read its contents)',
    'env.cred.missing': 'No credentials found in the environment or at {path}',
    'env.cred.fix': 'Configure an API key the way DSH expects (the plugin itself never touches keys)',
    'env.summary.ok': 'Everything looks good.',
    'env.summary.warn': '{count} item(s) need attention (most resolve themselves on first start).',
    'env.summary.fail': '{count} item(s) failed — apply the suggestions above and try again.',
    'env.checkFailed': 'Check failed: {message}',
    'env.report.ok': 'Environment check: no fatal problems found (see the plugin settings for details)',
    'env.report.fail': 'Environment check: {count} failed — {names} (see the plugin settings for details)',

    // ---- Settings ----
    'set.topDesc': 'The plugin starts a dsh subprocess with the sdk profile and drives it over newline-framed JSON-RPC. Empty paths are auto-detected.',
    'set.env.heading': 'Environment',
    'set.env.checkName': 'Check environment',
    'set.env.checkDesc': 'Checks node, the dsh artifact, the workspace, DSH_HOME, the profile, and credentials. Detection only — nothing is installed automatically.',
    'set.env.checkBtn': 'Run check',
    'set.env.checking': 'Checking…',
    'set.env.cliName': 'dsh CLI artifact (bin.js)',
    'set.env.cliDesc': 'Points at the built launcher in your checkout, e.g. <your repo>\\apps\\cli\\lib\\bin.js',
    'set.env.detectBtn': 'Auto-detect',
    'set.env.detected': 'Found: {path}',
    'set.env.notDetected': 'bin.js was not found in the usual locations — please enter the path manually',
    'set.env.nodeName': 'node executable',
    'set.env.nodeDesc': 'Leave empty to auto-detect; falls back to node on your PATH.',
    'set.env.cwdName': 'Workspace directory (cwd)',
    'set.env.cwdDesc': 'Passed as the initialize cwd — the agent\'s workspace root. Empty = vault root. Writes are confined to this directory by the sandbox.',
    'set.env.homeName': 'DSH_HOME',
    'set.env.homeDesc': 'Empty = the dsh default (~/.dsh). Only needed when your config directory is somewhere else.',
    'set.conn.heading': 'Connection and model routing',
    'set.conn.providerName': 'provider',
    'set.conn.providerDesc': 'Must match an adapter registered in DSH; deepseek-official is built in.',
    'set.conn.modelName': 'model',
    'set.conn.modelDesc': 'The route is validated by the adapter during the handshake; an unavailable route errors out instead of silently falling back.',
    'set.conn.effortName': 'reasoning effort',
    'set.conn.effortDesc': 'Optional and adapter-owned. Empty uses the model default.',
    'set.conn.maxTokensName': 'max tokens',
    'set.conn.maxTokensDesc': 'Output cap per model request; 0 uses the model default.',
    'set.conn.testName': 'Test connection',
    'set.conn.testDesc': 'Starts the runtime once and completes the initialize handshake to verify the settings above.',
    'set.conn.testBtn': 'Test',
    'set.conn.testing': 'Testing…',
    'set.conn.testOk': 'Connected: {name} v{version} ({ms}ms)',
    'set.conn.testFail': 'Connection failed: {title}',
    'set.interact.heading': 'Interaction',
    'set.interact.selModeName': 'Content sent on selection',
    'set.interact.selModeDesc': 'What the "Send selection to DSH" command sends. Sending a file location reference lets the agent read the file itself — cheaper in tokens and precise for partial-line selections.',
    'set.interact.selModeRef': 'File location reference only (recommended)',
    'set.interact.selModeText': 'Selected text only',
    'set.interact.selModeBoth': 'Reference + text',
    'set.interact.selActionName': 'After selecting',
    'set.interact.selActionDesc': 'Inserting into the input box lets you add an instruction before sending; sending immediately is quicker.',
    'set.interact.selActionInsert': 'Insert into the input box for editing',
    'set.interact.selActionSend': 'Send immediately',
    'set.interact.toolsName': 'Show tool calls',
    'set.interact.toolsDesc': 'Show compact activity lines such as 🔧 tool names in the conversation.',
    'set.interact.linkName': 'Clickable note paths',
    'set.interact.linkDesc': 'Render vault paths in replies as links that open in Obsidian (supports path.md:line for jumping to a line).',
    'set.interact.reconnectName': 'Auto-reconnect after a crash',
    'set.interact.reconnectDesc': 'Retries up to {max} times with exponential backoff when the runtime exits unexpectedly. Note: context resets after a reconnect — the protocol cannot resume a session across processes.',
    'set.lang.heading': 'Interface',
    'set.lang.name': 'Interface language',
    'set.lang.desc': 'Follow Obsidian to use its interface language, or force one here.',
    'set.lang.auto': 'Follow Obsidian',
    'set.lang.zh': '中文',
    'set.lang.en': 'English',
    'set.diag.heading': 'Diagnostics',
    'set.diag.copyName': 'Copy diagnostics',
    'set.diag.copyDesc': 'Copies the resolved values above plus the most recent handshake record, handy when reporting a problem.',
    'set.diag.copyBtn': 'Copy',
    'set.diag.copied': 'Diagnostics copied',
    'set.diag.clearName': 'Clear panel transcript',
    'set.diag.clearDesc': 'The panel keeps the most recent {max} messages so you can read them after a reload (transcript only, no context).',
    'set.diag.clearBtn': 'Clear',
    'set.diag.cleared': 'Panel transcript cleared',

    // ---- Diagnostics fields ----
    'diag.version': 'Plugin version',
    'diag.node': 'node',
    'diag.cli': 'dsh CLI artifact',
    'diag.home': 'DSH_HOME',
    'diag.profile': 'profile',
    'diag.cwd': 'Workspace directory',
    'diag.route': 'provider / model',
    'diag.effort': 'reasoning effort',
    'diag.maxTokens': 'max tokens',
    'diag.lastHandshake': 'Last handshake',
    'diag.noHandshake': '(no record on this machine yet)',
    'diag.handshakeOk': 'OK · {when}{ms}{server}',
    'diag.handshakeMs': ' · took {ms}ms',
    'diag.handshakeServer': ' · {name} v{version}',
    'diag.handshakeFail': 'Failed · {when} · {error}',
    'diag.runtime': 'Panel runtime',
    'diag.running': 'Running',
    'diag.notRunning': 'Not running',
    'diag.notFound': '(not found)',
    'diag.modelDefault': '(model default)',

    // ---- Notices and misc ----
    'notice.noSelection': 'Nothing is selected',
    'notice.nothingToSave': 'There is no reply to save yet',
    'notice.noActiveNote': 'No active note — copied to the clipboard',
    'notice.savedTo': 'Saved to {name}',
    'notice.openSettingsManually': 'Please open manually: Settings → Community plugins → DSH Native',
    'notice.sessionConflict': 'Session id conflict — retrying with a new session.',
    'notice.turnEnd': 'Turn ended: {kind}{detail}',
    'notice.turnEndDetail': ' ({detail})',
    'notice.maxTokens': 'output limit reached',
    'notice.compacted': 'Context compacted',
    'notice.subagentStarted': '↳ subagent started',
    'notice.reconnected': 'Reconnected.',
    'notice.restarted': 'Runtime restarted.',
    'notice.reconnectIn': 'Reconnecting in {seconds}s (attempt {n}/{max})…',
    'notice.reconnectGaveUp': 'Still failing after {max} reconnect attempts — try "Check environment".',
    'notice.error': 'Error: {message}',
    'notice.toolCall': '🔧 {name} {args}',
    'notice.toolError': '✗ {detail}',
  },
}

/** 把语言标签归一成 'zh' 或 'en'。 */
function normalizeLanguage(raw) {
  return String(raw || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 读 Obsidian 的界面语言。 */
function detectLanguage() {
  try {
    const stored = window.localStorage.getItem('language')
    if (stored) return normalizeLanguage(stored)
  } catch {
    /* 拿不到就用下面的兜底 */
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return normalizeLanguage(navigator.language)
  } catch {
    /* 忽略 */
  }
  return 'en'
}

/** 当前生效的语言（模块级，渲染时读取）。 */
let activeLang = 'en'

/**
 * 设置语言。
 * @param {'auto'|'zh'|'en'} [preference]
 * @returns {'zh'|'en'} 最终生效的语言
 */
function setLanguage(preference) {
  if (preference === 'zh' || preference === 'en') activeLang = preference
  else if (preference === undefined || preference === 'auto') activeLang = detectLanguage()
  else activeLang = normalizeLanguage(preference)
  return activeLang
}

/** 当前生效的语言。 */
function getLanguage() {
  return activeLang
}

/**
 * 取一条文案，并把 `{name}` 占位符替换掉。
 * @param {string} key
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
function t(key, vars) {
  const dict = DICT[activeLang] || DICT.en
  const raw = dict[key] !== undefined ? dict[key] : DICT.en[key] !== undefined ? DICT.en[key] : key
  if (!vars) return raw
  let text = raw
  for (const name of Object.keys(vars)) {
    text = text.split(`{${name}}`).join(String(vars[name]))
  }
  return text
}

/** 带 code 的错误，便于与界面语言解耦地识别。 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 新会话 id。服务端会用这个 id 调 agents.create，因此必须全局唯一。 */
function mintSessionId() {
  return `session-${randomUUID().replaceAll('-', '')}`
}

/** 取第一个存在的候选路径；都不存在时返回 `fallback`。 */
function firstExisting(candidates, fallback) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* 权限或路径异常一律跳过 */
    }
  }
  return fallback
}

/**
 * 从 `AssistantMessage.content` 这类内容块数组里拼出纯文本。
 * @param {unknown} content
 * @returns {string}
 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

/** 折叠空白并截断。 */
function squeeze(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/** 截断到 max 长度。 */
function truncate(text, max) {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 会话 id 冲突错误：进程重启后复用旧 id 时由服务端抛出。
 * @param {unknown} error
 */
function isSessionExistsError(error) {
  const message = error && error.message ? String(error.message) : String(error || '')
  return /already exists/i.test(message) && /session/i.test(message)
}

/**
 * 跑一个命令并收集 stdout。
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function execCapture(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout || ''))
    })
  })
}

/* ------------------------------------------------------------------ *
 * 错误翻译：把协议/进程层的错误变成人话 + 可执行动作
 * ------------------------------------------------------------------ */

/** 错误卡片上动作按钮的文案。 */
function actionLabel(action) {
  switch (action) {
    case 'retry': return t('action.retry')
    case 'settings': return t('action.settings')
    case 'check': return t('action.check')
    case 'restart': return t('action.restart')
    case 'newSession': return t('action.newSession')
    default: return ''
  }
}

/**
 * 把原始错误翻译成「标题 + 说明 + 排查建议 + 可点动作」。
 *
 * 自己抛的错误先按 `code` 判定（与界面语言无关），服务端返回的错误再按正则匹配。
 * 用户看到 `spawn ENOENT` 是没法自救的，得告诉他到底缺什么、下一步点哪里。
 *
 * @param {unknown} error
 * @returns {{ title: string, detail: string, hints: string[], actions: string[] }}
 */
function explainError(error) {
  const message = error && error.message ? String(error.message) : String(error || '')
  const lower = message.toLowerCase()
  const code = error && typeof error === 'object' ? error.code : undefined

  if (isSessionExistsError(error)) {
    return {
      title: t('err.sessionExists.title'),
      detail: message,
      hints: [t('err.sessionExists.hint1'), t('err.sessionExists.hint2')],
      actions: ['newSession', 'restart'],
    }
  }

  if (code === ERR.noCli) {
    return {
      title: t('err.noCli.title'),
      detail: message,
      hints: [t('err.noCli.hint1'), t('err.noCli.hint2')],
      actions: ['settings', 'check'],
    }
  }

  if (code === ERR.spawnFailed || /enoent/.test(lower)) {
    return {
      title: t('err.noNode.title'),
      detail: message,
      hints: [t('err.noNode.hint1'), t('err.noNode.hint2')],
      actions: ['settings', 'check'],
    }
  }

  if (code === ERR.timeout) {
    return {
      title: t('err.initTimeout.title'),
      detail: message,
      hints: [t('err.initTimeout.hint1'), t('err.initTimeout.hint2')],
      actions: ['restart', 'check'],
    }
  }

  if (code === ERR.exited || code === ERR.stopped) {
    return {
      title: t('err.runtimeExited.title'),
      detail: message,
      hints: [t('err.runtimeExited.hint1'), t('err.runtimeExited.hint2')],
      actions: ['restart', 'check'],
    }
  }

  if (/no adapter registered for provider/.test(lower)) {
    return {
      title: t('err.provider.title'),
      detail: message,
      hints: [t('err.provider.hint1'), t('err.provider.hint2')],
      actions: ['settings'],
    }
  }

  if (/credential|api key|unauthorized|401|authentication/.test(lower)) {
    return {
      title: t('err.credentials.title'),
      detail: message,
      hints: [t('err.credentials.hint1'), t('err.credentials.hint2')],
      actions: ['check'],
    }
  }

  if (/eperm|eacces/.test(lower)) {
    return {
      title: t('err.permission.title'),
      detail: message,
      hints: [t('err.permission.hint1'), t('err.permission.hint2')],
      actions: ['check'],
    }
  }

  return {
    title: t('err.generic.title'),
    detail: message || t('err.generic.detailFallback'),
    hints: [t('err.generic.hint1')],
    actions: ['retry', 'restart', 'check'],
  }
}

/* ------------------------------------------------------------------ *
 * 选中内容 -> 上下文
 * ------------------------------------------------------------------ */

/**
 * 按设置把编辑器选区转成要发给 agent 的文本。
 *
 * 只发「文件 + 行:列 + 字数」的引用，让 DSH 自己去读文件，比直接贴原文更省
 * token，而且能精确处理非整行选区。
 *
 * @param {any} editor
 * @param {any} file
 * @param {'reference'|'text'|'both'} mode
 * @returns {string}
 */
function buildSelectionPayload(editor, file, mode) {
  const selected = editor.getSelection()
  if (!selected || !selected.trim()) return ''

  if (mode === 'text' || !file) return selected

  const from = editor.getCursor('from')
  const to = editor.getCursor('to')
  const reference = buildSelectionReference(file.path, from, to, selected.length)

  return mode === 'both' ? `${reference}\n\n${selected}` : reference
}

/**
 * 构造那行「文件 + 行:列 + 字数」的引用。
 *
 * 中英各一套措辞，便于模型在两种语境下都读懂。
 *
 * @param {string} filePath
 * @param {{line: number, ch: number}} from
 * @param {{line: number, ch: number}} to
 * @param {number} length
 * @returns {string}
 */
function buildSelectionReference(filePath, from, to, length) {
  const startLine = from.line + 1
  const startCol = from.ch + 1
  const endLine = to.line + 1
  const endCol = to.ch + 1
  if (activeLang === 'zh') {
    return `[选中片段] 文件：${filePath}｜范围：第 ${startLine} 行第 ${startCol} 列 → 第 ${endLine} 行第 ${endCol} 列（共 ${length} 字符）｜请读取该文件对应范围后处理`
  }
  return `[selected passage] file: ${filePath} | range: line ${startLine} col ${startCol} -> line ${endLine} col ${endCol} (${length} chars) | read that range from the file and handle it`
}

/* ------------------------------------------------------------------ *
 * 面板内 vault 路径 -> 可点击链接
 * ------------------------------------------------------------------ */

/** 认为可链接的扩展名。 */
const LINKABLE_EXT = 'md|markdown|txt|canvas|json|csv|pdf|png|jpg|jpeg|gif|webp|svg|bmp|mp3|wav|mp4|webm|excalidraw'

/** 匹配 `目录/文件.md` 或 `文件.md:123` 形式。 */
const VAULT_PATH_RE = new RegExp(
  `([\\p{L}\\p{N}_\\-.~]+(?:/[\\p{L}\\p{N}_\\-.~]+)*\\.(?:${LINKABLE_EXT}))(?::(\\d+))?`,
  'giu',
)

/** 把文本里的路径解析成 vault 里的文件。 */
function resolveVaultFile(app, raw) {
  const candidates = [raw, raw.replace(/^\.\//, '')]
  try {
    candidates.push(decodeURIComponent(raw))
  } catch {
    /* 非法转义忽略 */
  }
  for (const candidate of candidates) {
    try {
      const dest = app.metadataCache.getFirstLinkpathDest(candidate, '')
      if (dest) return dest
    } catch {
      /* 忽略 */
    }
    try {
      const direct = app.vault.getAbstractFileByPath(candidate)
      if (direct) return direct
    } catch {
      /* 忽略 */
    }
  }
  return null
}

/** 打开文件后把光标移到指定行（可选）。 */
function revealLine(app, line) {
  if (!line) return
  window.setTimeout(() => {
    try {
      const view = app.workspace.getActiveViewOfType(MarkdownView)
      const editor = view && view.editor
      if (!editor) return
      const pos = { line: Math.max(0, line - 1), ch: 0 }
      editor.setCursor(pos)
      editor.scrollIntoView({ from: pos, to: pos }, true)
    } catch {
      /* 定位失败不影响打开文件 */
    }
  }, 80)
}

/** 处理单个文本节点：命中的路径换成可点击链接。 */
function linkifyTextNode(node, app) {
  const text = node.nodeValue
  if (!text || !text.includes('.')) return

  VAULT_PATH_RE.lastIndex = 0
  let match
  let last = 0
  let fragment = null

  while ((match = VAULT_PATH_RE.exec(text)) !== null) {
    const raw = match[1]
    const file = resolveVaultFile(app, raw)
    if (!file) continue

    const line = match[2] ? Number.parseInt(match[2], 10) : 0
    if (!fragment) fragment = document.createDocumentFragment()
    if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)))

    const anchor = document.createElement('a')
    anchor.className = 'internal-link'
    anchor.textContent = match[0]
    anchor.href = '#'
    anchor.addEventListener('click', (event) => {
      event.preventDefault()
      void app.workspace.openLinkText(file.path, '', false)
      revealLine(app, line)
    })
    fragment.appendChild(anchor)
    last = match.index + match[0].length
  }

  if (!fragment) return
  if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
  if (node.parentNode) node.parentNode.replaceChild(fragment, node)
}

/**
 * 扫描渲染结果，把 vault 内存在的路径变成可点击链接。
 * 跳过代码块、行内代码、已有链接和工具活动行。
 */
function linkifyVaultPaths(root, app, enabled) {
  if (!enabled || !root || typeof document === 'undefined' || typeof NodeFilter === 'undefined') return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes('.')) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('code, pre, a, .dsh-tool, .dsh-error-card, .dsh-env-list')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets = []
  let current
  while ((current = walker.nextNode()) !== null) targets.push(current)
  for (const node of targets) linkifyTextNode(node, app)
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 运行时客户端
 * ------------------------------------------------------------------ */

/**
 * 驱动 `dsh --profile sdk` 子进程的极小 JSON-RPC 客户端。
 */
class DshRuntime {
  /**
   * @param {object} options
   * @param {string} options.nodePath
   * @param {string} options.cliPath
   * @param {string} options.profile
   * @param {string} options.cwd 工作区根目录（agent 的 session.header.cwd）
   * @param {string} options.provider
   * @param {string} options.model
   * @param {string} [options.reasoningEffort]
   * @param {number} [options.maxTokens]
   * @param {string} [options.dshHome]
   * @param {(method: string, params: any) => void} [options.onNotification]
   * @param {(text: string) => void} [options.onStderr]
   * @param {(code: number|null, signal: string|null) => void} [options.onExit]
   */
  constructor(options) {
    this.options = options
    this.child = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.stopped = false
    this.serverInfo = null
    /** 最近一次 initialize 的耗时（毫秒）。 */
    this.handshakeMs = 0
  }

  /** 子进程是否仍在运行。 */
  get alive() {
    return this.child !== null && this.child.exitCode === null && !this.stopped
  }

  /** 启动子进程并完成 initialize 握手，成功后 resolve `serverInfo`。 */
  async start() {
    if (this.alive) return this.serverInfo

    const env = { ...process.env }
    if (this.options.dshHome) env.DSH_HOME = this.options.dshHome

    const args = [this.options.cliPath, '--profile', this.options.profile]
    this.child = spawn(this.options.nodePath, args, {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk))
    this.child.stderr.on('data', (chunk) => {
      if (this.options.onStderr) this.options.onStderr(chunk)
    })
    this.child.on('error', (error) => {
      this._failAll(codedError(ERR.spawnFailed, t('raised.spawnFailed', { message: error.message })))
    })
    this.child.on('exit', (code, signal) => {
      const wasStopped = this.stopped
      this._failAll(codedError(ERR.exited, t('raised.exited', { code, signal })))
      if (!wasStopped && this.options.onExit) this.options.onExit(code, signal)
    })

    const params = {
      cwd: this.options.cwd,
      provider: this.options.provider,
      model: this.options.model,
    }
    if (this.options.reasoningEffort) params.reasoningEffort = this.options.reasoningEffort
    if (Number.isSafeInteger(this.options.maxTokens) && this.options.maxTokens > 0) {
      params.maxTokens = this.options.maxTokens
    }

    const startedAt = Date.now()
    const result = await this.request('initialize', params, INIT_TIMEOUT_MS)
    this.handshakeMs = Date.now() - startedAt
    this.serverInfo = result && result.serverInfo
      ? result.serverInfo
      : { name: 'unknown', version: 'unknown' }
    return this.serverInfo
  }

  /**
   * 发送一个请求并等待响应。
   * @param {string} method
   * @param {object} params
   * @param {number} [timeoutMs]
   */
  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.child) {
        reject(codedError(ERR.notRunning, t('raised.notRunning')))
        return
      }
      const id = this.nextId++
      const timer = timeoutMs
        ? setTimeout(() => {
            if (this.pending.delete(id)) {
              reject(codedError(ERR.timeout, t('raised.timeout', { method, ms: timeoutMs })))
            }
          }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        if (this.pending.delete(id)) reject(error)
      }
    })
  }

  /** 排队一条用户消息，resolve 持久入队回执 `{ messageId }`。 */
  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] })
  }

  /** 关掉子进程。协议层没有逐轮取消，停止即关闭运行时。 */
  stop() {
    if (!this.child) return
    this.stopped = true
    const child = this.child
    this.child = null
    try {
      child.stdin.end()
    } catch {
      /* 忽略 */
    }
    // stdin EOF -> SIGTERM -> SIGKILL 阶梯
    const termTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 忽略 */
      }
    }, 1000)
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
    }, 4000)
    child.once('exit', () => {
      clearTimeout(termTimer)
      clearTimeout(killTimer)
    })
    this._failAll(codedError(ERR.stopped, t('raised.stopped')))
  }

  /** 处理 stdout 分片，按换行切帧。 */
  _onStdout(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this._onLine(line)
    }
  }

  /** 逐帧分发：带 id+method 是请求，仅 id 是响应，仅 method 是通知。 */
  _onLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      return // 协议规定：格式错误的行忽略
    }
    if (!message || typeof message !== 'object') return

    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        const code = message.error.code === undefined ? '?' : message.error.code
        const text = message.error.message === undefined ? t('raised.serverUnknownError') : message.error.message
        entry.reject(new Error(`[${code}] ${text}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }

    if (message.method !== undefined && message.id === undefined) {
      if (this.options.onNotification) this.options.onNotification(message.method, message.params)
    }
  }

  /** 让所有挂起请求失败（进程死亡或主动停止时）。 */
  _failAll(error) {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/* ------------------------------------------------------------------ *
 * 对话面板
 * ------------------------------------------------------------------ */

class DshView extends ItemView {
  /**
   * @param {obsidian.WorkspaceLeaf} leaf
   * @param {DshPlugin} plugin
   */
  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
    this.runtime = null
    this.sessionId = mintSessionId()
    /** 当前 sessionId 是否已经成功发过消息（用于判断是否是重启后的复用）。 */
    this.sessionUsed = false
    this.turnWaiter = null
    this.lastAnswer = ''
    this.lastPrompt = ''
    this.busy = false
    this.transcript = []
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.userStopped = false
  }

  getViewType() {
    return VIEW_TYPE
  }

  getDisplayText() {
    return 'DSH Native'
  }

  getIcon() {
    return 'bot'
  }

  async onOpen() {
    const root = this.contentEl
    root.empty()
    root.addClass('dsh-view')

    // ---- 头部 ----
    const header = root.createDiv({ cls: 'dsh-header' })
    const status = header.createDiv({ cls: 'dsh-status' })
    this.dotEl = status.createDiv({ cls: 'dsh-dot' })
    this.statusEl = status.createSpan({ text: t('panel.status.disconnected') })

    this.actionsEl = header.createDiv({ cls: 'dsh-header-actions' })

    this.btnNew = this.actionsEl.createEl('button', { text: t('panel.newSession') })
    this.btnNew.onclick = () => this.newSession()
    this.btnRestart = this.actionsEl.createEl('button', { text: t('panel.restart') })
    this.btnRestart.onclick = () => void this.restartRuntime()
    this.btnInsert = this.actionsEl.createEl('button', { text: t('panel.insertIntoNote') })
    this.btnInsert.onclick = () => void this.insertIntoNote()
    this.btnStop = this.actionsEl.createEl('button', { text: t('panel.stop') })
    this.btnStop.onclick = () => this.stopRuntime()

    // ---- 消息区 ----
    this.messagesEl = root.createDiv({ cls: 'dsh-messages' })
    if (!this.restoreTranscript()) this.renderEmpty()

    // ---- 输入区 ----
    const inputRow = root.createDiv({ cls: 'dsh-input-row' })
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'dsh-input',
      attr: { placeholder: t('panel.inputPlaceholder') },
    })
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void this.submit()
      }
    })
    const actions = inputRow.createDiv({ cls: 'dsh-input-actions' })
    this.hintEl = actions.createDiv({ cls: 'dsh-hint' })
    this.hintEl.setText(t('panel.workspaceHint', { path: this.plugin.getWorkspaceRoot() }))
    this.sendBtn = actions.createEl('button', { text: t('panel.send'), cls: 'mod-cta' })
    this.sendBtn.onclick = () => void this.submit()
  }

  async onClose() {
    this.clearReconnect()
    this.stopRuntime()
    await this.plugin.flushTranscript()
  }

  /** 语言改变后刷新面板上的静态文案。 */
  applyLanguage() {
    if (!this.statusEl) return
    if (this.btnNew) this.btnNew.setText(t('panel.newSession'))
    if (this.btnRestart) this.btnRestart.setText(t('panel.restart'))
    if (this.btnInsert) this.btnInsert.setText(t('panel.insertIntoNote'))
    if (this.btnStop) this.btnStop.setText(t('panel.stop'))
    if (this.sendBtn) this.sendBtn.setText(t('panel.send'))
    if (this.inputEl) this.inputEl.setAttribute('placeholder', t('panel.inputPlaceholder'))
    if (this.hintEl) this.hintEl.setText(t('panel.workspaceHint', { path: this.plugin.getWorkspaceRoot() }))
    if (!this.runtime || !this.runtime.alive) this.setStatus(t('panel.status.disconnected'), null)
  }

  /* ---------------- 渲染 ---------------- */

  /** 面板内的空状态提示。 */
  renderEmpty() {
    this.messagesEl.empty()
    const empty = this.messagesEl.createDiv({ cls: 'dsh-empty' })
    empty.createDiv({ text: t('panel.empty.line1') })
    empty.createDiv({ text: t('panel.empty.line2') })
    empty.createDiv({ text: t('panel.empty.line3') })
  }

  /** 从持久化数据恢复上次的对话记录（仅用于阅读）。 */
  restoreTranscript() {
    const saved = this.plugin.settings.transcript
    if (!saved || !Array.isArray(saved.messages) || saved.messages.length === 0) return false
    this.transcript = saved.messages.slice()
    this.messagesEl.empty()
    this.appendNotice(t('panel.restored'))
    for (const entry of this.transcript) this.renderEntry(entry)
    return true
  }

  /** 更新状态指示。 */
  setStatus(text, kind) {
    if (!this.statusEl) return
    this.statusEl.setText(text)
    this.dotEl.removeClass('is-running')
    this.dotEl.removeClass('is-error')
    if (kind === 'running') this.dotEl.addClass('is-running')
    if (kind === 'error') this.dotEl.addClass('is-error')
  }

  /** 滚动到底部。 */
  scrollToBottom() {
    const el = this.messagesEl
    window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }

  /**
   * 记录一条消息（进内存 + 持久化）并渲染。
   *
   * 渲染只走这一条路径：append* 只负责画 DOM、不负责记录。否则会形成
   * 「记录 -> renderEntry -> append* -> 又画一遍」的双重渲染。
   */
  pushEntry(entry) {
    entry.text = truncate(entry.text, MAX_ENTRY_CHARS)
    this.transcript.push(entry)
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT)
    }
    this.renderEntry(entry)
    this.plugin.queueTranscriptSave(this.transcript)
  }

  /** 只画 DOM，不记录（pushEntry 与恢复历史都走这里）。 */
  renderEntry(entry) {
    if (entry.role === 'user') this.appendUser(entry.text)
    else if (entry.role === 'tool') this.appendToolLine(entry.text, Boolean(entry.error))
    else if (entry.role === 'notice') this.appendNotice(entry.text)
    else this.appendAssistant(entry.text)
  }

  /** 画一条用户消息。 */
  appendUser(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-msg dsh-msg-user' })
    el.setText(text)
    this.scrollToBottom()
  }

  /** 画一条助手消息。 */
  appendAssistant(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-msg dsh-msg-assistant' })
    try {
      if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
        const rendered = MarkdownRenderer.render(this.app, text, el, '', this)
        // render 返回 promise：异步失败时回退成纯文本，避免静默空白
        if (rendered && typeof rendered.catch === 'function') {
          rendered
            .then(() => this.postProcess(el))
            .catch(() => {
              el.setText(text)
              this.postProcess(el)
            })
        } else {
          this.postProcess(el)
        }
      } else {
        el.setText(text)
      }
    } catch {
      el.setText(text)
    }
    this.scrollToBottom()
  }

  /** 渲染后处理：把 vault 路径变成可点击链接。 */
  postProcess(el) {
    try {
      linkifyVaultPaths(el, this.app, this.plugin.settings.linkifyPaths)
    } catch {
      /* 链接化失败不影响正文 */
    }
  }

  /** 画一行工具活动。 */
  appendToolLine(text, isError) {
    const el = this.messagesEl.createDiv({ cls: isError ? 'dsh-tool is-error' : 'dsh-tool' })
    el.setText(text)
    this.scrollToBottom()
  }

  /** 画一行提示。 */
  appendNotice(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-notice-line' })
    el.setText(text)
    this.scrollToBottom()
  }

  /** 在面板里显示一张可操作的错误卡片。 */
  showErrorCard(error) {
    const info = explainError(error)
    const card = this.messagesEl.createDiv({ cls: 'dsh-error-card' })
    card.createDiv({ cls: 'dsh-error-title', text: info.title })
    if (info.detail && info.detail !== info.title) {
      card.createDiv({ cls: 'dsh-error-detail', text: info.detail })
    }
    if (info.hints.length > 0) {
      const list = card.createEl('ul', { cls: 'dsh-error-hints' })
      for (const hint of info.hints) list.createEl('li', { text: hint })
    }
    if (info.actions.length > 0) {
      const row = card.createDiv({ cls: 'dsh-error-actions' })
      for (const action of info.actions) {
        const label = actionLabel(action)
        if (!label) continue
        const button = row.createEl('button', { text: label })
        button.onclick = () => void this.runErrorAction(action)
      }
    }
    this.scrollToBottom()
  }

  /** 执行错误卡片上的动作。 */
  async runErrorAction(action) {
    switch (action) {
      case 'retry':
        if (this.lastPrompt) {
          this.inputEl.value = this.lastPrompt
          await this.submit()
        }
        return
      case 'settings':
        try {
          this.app.setting.open()
          this.app.setting.openTabById(this.plugin.manifest.id)
        } catch {
          new Notice(t('notice.openSettingsManually'))
        }
        return
      case 'check':
        await this.plugin.runEnvironmentCheckAndReport()
        return
      case 'restart':
        await this.restartRuntime()
        return
      case 'newSession':
        this.newSession()
        return
      default:
        return
    }
  }

  /* ---------------- 运行时生命周期 ---------------- */

  /** 确保运行时已就绪；返回 runtime 或抛出错误。 */
  async ensureRuntime() {
    if (this.runtime && this.runtime.alive) return this.runtime

    const settings = this.plugin.settings
    const nodePath = this.plugin.getNodePath()
    const cliPath = this.plugin.getCliPath()
    if (!cliPath) {
      throw codedError(ERR.noCli, t('raised.noCli'))
    }

    // 新进程无法复用旧会话 id（会话已持久化，create 会拒绝），必须换新 id
    const wasRunning = this.sessionUsed
    this.sessionId = mintSessionId()
    if (wasRunning) {
      this.pushEntry({ role: 'notice', text: t('panel.runtimeRestarted') })
    }

    const runtime = new DshRuntime({
      nodePath,
      cliPath,
      profile: settings.profile,
      cwd: this.plugin.getWorkspaceRoot(),
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      maxTokens: settings.maxTokens,
      dshHome: settings.dshHome,
      onNotification: (method, params) => this.onNotification(method, params),
      onStderr: (text) => this.appendNoticeIfUseful(text),
      onExit: (code) => this.onRuntimeExit(code),
    })

    this.setStatus(t('panel.status.starting'), 'running')
    const info = await runtime.start()
    this.runtime = runtime
    this.sessionUsed = false
    this.reconnectAttempts = 0
    this.setStatus(t('panel.status.connected', { name: info.name }), null)
    await this.plugin.recordHandshake({
      ok: true,
      at: Date.now(),
      serverInfo: info,
      handshakeMs: runtime.handshakeMs,
      provider: settings.provider,
      model: settings.model,
      profile: settings.profile,
      cwd: this.plugin.getWorkspaceRoot(),
    })
    return runtime
  }

  /** 运行时意外退出。 */
  onRuntimeExit(code) {
    this.runtime = null
    this.setStatus(t('panel.status.exited', { code }), 'error')
    this.pushEntry({ role: 'notice', text: t('panel.status.exited', { code }) })
    this.showErrorCard(codedError(ERR.exited, t('raised.exited', { code, signal: null })))
    void this.plugin.recordHandshake({ ok: false, at: Date.now(), error: `exit code=${code}` })

    if (!this.plugin.settings.autoReconnect || this.userStopped) return
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.pushEntry({ role: 'notice', text: t('notice.reconnectGaveUp', { max: MAX_RECONNECT }) })
      return
    }
    this.reconnectAttempts += 1
    const delayMs = 1000 * 2 ** (this.reconnectAttempts - 1)
    this.pushEntry({
      role: 'notice',
      text: t('notice.reconnectIn', {
        seconds: Math.round(delayMs / 1000),
        n: this.reconnectAttempts,
        max: MAX_RECONNECT,
      }),
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.autoReconnect()
    }, delayMs)
  }

  /** 自动重连。 */
  async autoReconnect() {
    if (this.userStopped) return
    try {
      await this.ensureRuntime()
      this.pushEntry({ role: 'notice', text: t('notice.reconnected') })
    } catch (error) {
      this.showErrorCard(error)
      this.onRuntimeExit('reconnect-failed')
    }
  }

  /** 清掉待执行的重连定时器。 */
  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** 用户主动重启运行时。 */
  async restartRuntime() {
    this.clearReconnect()
    this.userStopped = false
    this.reconnectAttempts = 0
    if (this.runtime) {
      this.runtime.stop()
      this.runtime = null
    }
    this.setStatus(t('panel.status.restarting'), 'running')
    try {
      await this.ensureRuntime()
      this.pushEntry({ role: 'notice', text: t('notice.restarted') })
    } catch (error) {
      this.setStatus(t('panel.status.restartFailed'), 'error')
      this.showErrorCard(error)
    }
  }

  /** 停止运行时（协议层没有逐轮取消，只能关进程）。 */
  stopRuntime() {
    this.clearReconnect()
    this.userStopped = true
    this.finishTurn()
    if (this.runtime) {
      this.runtime.stop()
      this.runtime = null
    }
    this.setStatus(t('panel.status.stopped'), null)
  }

  /* ---------------- 通知与事件 ---------------- */

  /** 处理服务端通知。 */
  onNotification(method, params) {
    if (!params) return

    if (method === 'session.event') {
      if (params.sessionId !== this.sessionId) return
      this.onSessionEvent(params.event)
      return
    }

    if (method === 'session.status') {
      if (params.sessionId !== this.sessionId) return
      if (params.status === 'running') {
        this.setStatus(t('panel.status.running'), 'running')
        if (this.turnWaiter) this.turnWaiter.sawRunning = true
      } else if (params.status === 'idle') {
        this.setStatus(t('panel.status.ready'), null)
        this.maybeFinishTurn()
      }
      return
    }

    if (method === 'subagent.started') {
      if (params.parentSessionId !== this.sessionId && params.childSessionId !== this.sessionId) return
      this.pushEntry({ role: 'tool', text: t('notice.subagentStarted') })
    }
  }

  /** 处理一条会话事件。 */
  onSessionEvent(event) {
    if (!event || typeof event !== 'object') return
    const data = event.data || {}

    switch (event.type) {
      case 'assistant/message': {
        const message = data.message || {}
        const text = blocksToText(message.content)
        if (text.trim()) {
          this.lastAnswer = text
          this.pushEntry({ role: 'assistant', text })
        }
        return
      }
      case 'tool/call': {
        if (!this.plugin.settings.showToolActivity) return
        const name = data.name || 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : ''
        this.pushEntry({ role: 'tool', text: t('notice.toolCall', { name, args: truncate(squeeze(args), 160) }) })
        return
      }
      case 'tool/result': {
        if (!this.plugin.settings.showToolActivity) return
        if (data.error) {
          const detail = `${data.error.name || 'error'}: ${data.error.code || ''}`
          this.pushEntry({ role: 'tool', text: t('notice.toolError', { detail: truncate(detail, 160) }), error: true })
        }
        return
      }
      case 'turn/end': {
        this.reportTurnEnd(data.reason)
        this.maybeFinishTurn()
        return
      }
      case 'compaction/summary': {
        this.pushEntry({ role: 'notice', text: t('notice.compacted') })
        return
      }
      default:
        return
    }
  }

  /**
   * 把 `turn/end` 的 reason 翻译成可读提示。
   *
   * `TurnEndReason` 始终是带 `kind` 的对象（实测 `{kind:'completed'}`），
   * 取值：completed / aborted / blocked / error / max-tokens / interrupted。
   * 正常完成时保持静默。
   *
   * @param {any} reason
   */
  reportTurnEnd(reason) {
    if (!reason) return
    const kind = typeof reason === 'object' ? reason.kind : reason
    if (!kind || kind === 'completed') return

    let detail = ''
    if (kind === 'error' && reason.error) {
      detail = reason.error.message || reason.error.code || ''
    } else if (kind === 'max-tokens') {
      detail = t('notice.maxTokens')
    } else if (kind === 'aborted' && reason.reason) {
      detail = typeof reason.reason === 'object' ? reason.reason.kind || '' : String(reason.reason)
    }
    this.pushEntry({
      role: 'notice',
      text: t('notice.turnEnd', { kind, detail: detail ? t('notice.turnEndDetail', { detail }) : '' }),
    })
  }

  /** 把 stderr 的推理/错误行转成提示（只挑有信息量的行，避免刷屏）。 */
  appendNoticeIfUseful(text) {
    if (!text) return
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('dsh: reasoning:')) continue // 推理增量太碎，不逐条铺进面板
      if (line.startsWith('dsh:')) this.pushEntry({ role: 'notice', text: line })
    }
  }

  /* ---------------- 一轮对话 ---------------- */

  /**
   * 开始等待本轮结束。
   *
   * 判定条件：必须先在 `session.status` 上观察到 `running`，之后收到
   * `turn/end` 或 `running -> idle` 才算结束。要求 `sawRunning` 是为了排除
   * 「上一轮遗留的 idle」把本轮提前判定为完成。
   *
   * @returns {Promise<void>}
   */
  beginTurn() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishTurn(), TURN_TIMEOUT_MS)
      this.turnWaiter = { resolve, timer, sawRunning: false }
    })
  }

  /** 收尾本轮：清掉 waiter 并 resolve（幂等）。 */
  finishTurn() {
    if (!this.turnWaiter) return
    const waiter = this.turnWaiter
    this.turnWaiter = null
    clearTimeout(waiter.timer)
    waiter.resolve()
  }

  /** 本轮确认结束时收尾。 */
  maybeFinishTurn() {
    if (this.turnWaiter && this.turnWaiter.sawRunning) this.finishTurn()
  }

  /** 把命令产生的内容放进输入框（不覆盖用户已输入的文字）。 */
  prefill(text) {
    const existing = this.inputEl.value.trim()
    this.inputEl.value = existing ? `${text}\n\n${existing}` : text
    this.inputEl.focus()
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length)
  }

  /** 发送输入框里的内容。 */
  async submit() {
    const text = this.inputEl.value.trim()
    if (!text || this.busy) return

    this.busy = true
    this.userStopped = false
    this.lastPrompt = text
    this.inputEl.value = ''
    // 先摘掉空状态提示，再追加用户消息（顺序反了会把用户消息一起清掉）
    const emptyState = this.messagesEl.querySelector('.dsh-empty')
    if (emptyState) emptyState.remove()
    this.pushEntry({ role: 'user', text })
    // 在 prompt 之前就登记本轮，避免极快的回合在收到回执前就结束
    const turn = this.beginTurn()

    try {
      let runtime = await this.ensureRuntime()
      try {
        await runtime.prompt(this.sessionId, text)
      } catch (error) {
        if (!isSessionExistsError(error)) throw error
        // 会话 id 撞了（例如进程被外部重启过）：换新 id 重试一次
        this.sessionId = mintSessionId()
        this.pushEntry({ role: 'notice', text: t('notice.sessionConflict') })
        runtime = await this.ensureRuntime()
        await runtime.prompt(this.sessionId, text)
      }
      this.sessionUsed = true
      this.setStatus(t('panel.status.running'), 'running')
      await turn
      this.setStatus(t('panel.status.ready'), null)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.setStatus(t('panel.status.error'), 'error')
      this.pushEntry({ role: 'notice', text: t('notice.error', { message: truncate(message, 300) }) })
      this.showErrorCard(error)
      void this.plugin.recordHandshake({ ok: false, at: Date.now(), error: message })
    } finally {
      this.finishTurn()
      this.busy = false
    }
  }

  /** 开一个新会话（同一运行时进程内换一个 sessionId）。 */
  newSession() {
    this.finishTurn()
    this.sessionId = mintSessionId()
    this.sessionUsed = false
    this.lastAnswer = ''
    this.renderEmpty()
    this.setStatus(
      this.runtime && this.runtime.alive ? t('panel.status.readyNewSession') : t('panel.status.disconnected'),
      null,
    )
  }

  /** 把最后一条助手消息追加到当前笔记。 */
  async insertIntoNote() {
    if (!this.lastAnswer) {
      new Notice(t('notice.nothingToSave'))
      return
    }
    const file = this.app.workspace.getActiveFile()
    if (!file) {
      await navigator.clipboard.writeText(this.lastAnswer)
      new Notice(t('notice.noActiveNote'))
      return
    }
    const existing = await this.app.vault.read(file)
    const separator = existing.endsWith('\n') ? '\n' : '\n\n'
    await this.app.vault.modify(file, `${existing}${separator}${this.lastAnswer}\n`)
    new Notice(t('notice.savedTo', { name: file.basename }))
  }
}

/* ------------------------------------------------------------------ *
 * 环境检测
 * ------------------------------------------------------------------ */

/**
 * 逐项检查运行本插件所需的条件。
 *
 * 只做检测与给出修复建议，**不自动安装任何东西** —— 保持插件轻量、
 * 不做用户没要求的副作用。
 *
 * @param {DshPlugin} plugin
 * @returns {Promise<Array<{ name: string, status: 'ok'|'warn'|'fail', detail: string, fix?: string }>>}
 */
async function checkEnvironment(plugin) {
  const results = []
  const settings = plugin.settings

  // 1) node
  const nodePath = plugin.getNodePath()
  try {
    const version = (await execCapture(nodePath, ['--version'], 15000)).trim()
    results.push({ name: t('env.node'), status: 'ok', detail: t('env.node.ok', { path: nodePath, version }) })
  } catch (error) {
    results.push({
      name: t('env.node'),
      status: 'fail',
      detail: t('env.node.fail', { path: nodePath, message: error && error.message ? error.message : String(error) }),
      fix: t('env.node.fix'),
    })
  }

  // 2) dsh CLI 产物
  const cliPath = plugin.getCliPath()
  if (cliPath && fs.existsSync(cliPath)) {
    results.push({ name: t('env.cli'), status: 'ok', detail: cliPath })
  } else {
    results.push({
      name: t('env.cli'),
      status: 'fail',
      detail: cliPath ? t('env.cli.notFoundFile', { path: cliPath }) : t('env.cli.missing'),
      fix: t('env.cli.fix'),
    })
  }

  // 3) 工作区目录
  const cwd = plugin.getWorkspaceRoot()
  try {
    const stat = fs.statSync(cwd)
    results.push({
      name: t('env.workspace'),
      status: stat.isDirectory() ? 'ok' : 'fail',
      detail: cwd,
      fix: stat.isDirectory() ? undefined : t('env.workspace.notDir'),
    })
  } catch {
    results.push({
      name: t('env.workspace'),
      status: 'fail',
      detail: t('env.workspace.missing', { path: cwd }),
      fix: t('env.workspace.fix'),
    })
  }

  // 4) DSH_HOME
  const dshHome = settings.dshHome || path.join(os.homedir(), '.dsh')
  if (fs.existsSync(dshHome)) {
    results.push({ name: t('env.home'), status: 'ok', detail: dshHome })
  } else {
    results.push({
      name: t('env.home'),
      status: 'warn',
      detail: t('env.home.missing', { path: dshHome }),
      fix: t('env.home.fix'),
    })
  }

  // 5) profile 目录
  const profileDir = path.join(dshHome, 'profiles', settings.profile || 'sdk')
  results.push(
    fs.existsSync(profileDir)
      ? { name: t('env.profile', { name: settings.profile }), status: 'ok', detail: profileDir }
      : {
          name: t('env.profile', { name: settings.profile }),
          status: 'warn',
          detail: t('env.profile.missing', { path: profileDir }),
          fix: t('env.profile.fix'),
        },
  )

  // 6) 凭据（只看是否存在，绝不读取内容）
  const credFile = path.join(dshHome, '.credentials.yaml')
  const hasEnvKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (hasEnvKey) {
    results.push({ name: t('env.cred'), status: 'ok', detail: t('env.cred.env') })
  } else if (fs.existsSync(credFile)) {
    results.push({ name: t('env.cred'), status: 'ok', detail: t('env.cred.file', { path: credFile }) })
  } else {
    results.push({
      name: t('env.cred'),
      status: 'warn',
      detail: t('env.cred.missing', { path: credFile }),
      fix: t('env.cred.fix'),
    })
  }

  return results
}

/* ------------------------------------------------------------------ *
 * 设置页
 * ------------------------------------------------------------------ */

class DshSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl('h2', { text: 'DSH Native' })
    containerEl.createEl('p', { cls: 'setting-item-description', text: t('set.topDesc') })

    this.renderLanguageSection(containerEl)
    this.renderEnvironmentSection(containerEl)
    this.renderConnectionSection(containerEl)
    this.renderInteractionSection(containerEl)
    this.renderDiagnosticsSection(containerEl)
  }

  /** 界面语言区。 */
  renderLanguageSection(containerEl) {
    containerEl.createEl('h3', { text: t('set.lang.heading') })

    new Setting(containerEl)
      .setName(t('set.lang.name'))
      .setDesc(t('set.lang.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('auto', t('set.lang.auto'))
          .addOption('zh', t('set.lang.zh'))
          .addOption('en', t('set.lang.en'))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value
            await this.plugin.saveSettings()
            this.plugin.applyLanguage()
            this.display()
          }),
      )
  }

  /** 环境检测区。 */
  renderEnvironmentSection(containerEl) {
    containerEl.createEl('h3', { text: t('set.env.heading') })

    this.envResultEl = containerEl.createDiv({ cls: 'dsh-env-list' })

    new Setting(containerEl)
      .setName(t('set.env.checkName'))
      .setDesc(t('set.env.checkDesc'))
      .addButton((button) =>
        button.setButtonText(t('set.env.checkBtn')).onClick(async () => {
          button.setDisabled(true)
          button.setButtonText(t('set.env.checking'))
          this.envResultEl.empty()
          try {
            const results = await checkEnvironment(this.plugin)
            this.renderEnvResults(results)
          } catch (error) {
            this.envResultEl.createDiv({
              text: t('env.checkFailed', { message: error && error.message ? error.message : String(error) }),
            })
          } finally {
            button.setDisabled(false)
            button.setButtonText(t('set.env.checkBtn'))
          }
        }),
      )

    new Setting(containerEl)
      .setName(t('set.env.cliName'))
      .setDesc(t('set.env.cliDesc'))
      .addText((text) =>
        text
          .setPlaceholder(firstExisting(CLI_CANDIDATES, '') || 'C:\\path\\to\\deepseek-harness\\apps\\cli\\lib\\bin.js')
          .setValue(this.plugin.settings.cliPath)
          .onChange(async (value) => {
            this.plugin.settings.cliPath = value.trim()
            await this.plugin.saveSettings()
          }),
      )
      .addButton((button) =>
        button.setButtonText(t('set.env.detectBtn')).onClick(async () => {
          const found = firstExisting(CLI_CANDIDATES, '')
          if (found) {
            this.plugin.settings.cliPath = found
            await this.plugin.saveSettings()
            new Notice(t('set.env.detected', { path: found }))
          } else {
            new Notice(t('set.env.notDetected'))
          }
          this.display()
        }),
      )

    new Setting(containerEl)
      .setName(t('set.env.nodeName'))
      .setDesc(t('set.env.nodeDesc'))
      .addText((text) =>
        text
          .setPlaceholder(firstExisting(NODE_CANDIDATES, 'node'))
          .setValue(this.plugin.settings.nodePath)
          .onChange(async (value) => {
            this.plugin.settings.nodePath = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.env.cwdName'))
      .setDesc(t('set.env.cwdDesc'))
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getDefaultWorkspaceRoot())
          .setValue(this.plugin.settings.cwd)
          .onChange(async (value) => {
            this.plugin.settings.cwd = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.env.homeName'))
      .setDesc(t('set.env.homeDesc'))
      .addText((text) =>
        text
          .setPlaceholder(path.join(os.homedir(), '.dsh'))
          .setValue(this.plugin.settings.dshHome)
          .onChange(async (value) => {
            this.plugin.settings.dshHome = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl).setName(t('diag.profile')).addText((text) =>
      text
        .setPlaceholder('sdk')
        .setValue(this.plugin.settings.profile)
        .onChange(async (value) => {
          this.plugin.settings.profile = value.trim() || 'sdk'
          await this.plugin.saveSettings()
        }),
    )
  }

  /** 渲染环境检测结果。 */
  renderEnvResults(results) {
    const el = this.envResultEl
    el.empty()
    const icon = { ok: '✅', warn: '⚠️', fail: '❌' }
    for (const item of results) {
      const row = el.createDiv({ cls: `dsh-env-row is-${item.status}` })
      row.createSpan({ cls: 'dsh-env-icon', text: icon[item.status] || '•' })
      const body = row.createDiv({ cls: 'dsh-env-body' })
      body.createDiv({ cls: 'dsh-env-name', text: item.name })
      body.createDiv({ cls: 'dsh-env-detail', text: item.detail })
      if (item.fix) body.createDiv({ cls: 'dsh-env-fix', text: item.fix })
    }
    const bad = results.filter((r) => r.status === 'fail').length
    const warn = results.filter((r) => r.status === 'warn').length
    const summary = bad === 0
      ? (warn === 0 ? t('env.summary.ok') : t('env.summary.warn', { count: warn }))
      : t('env.summary.fail', { count: bad })
    el.createDiv({ cls: 'dsh-env-summary', text: summary })
  }

  /** 连接与模型路由区。 */
  renderConnectionSection(containerEl) {
    containerEl.createEl('h3', { text: t('set.conn.heading') })

    new Setting(containerEl)
      .setName(t('set.conn.providerName'))
      .setDesc(t('set.conn.providerDesc'))
      .addText((text) =>
        text
          .setPlaceholder('deepseek-official')
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.conn.modelName'))
      .setDesc(t('set.conn.modelDesc'))
      .addText((text) =>
        text
          .setPlaceholder('deepseek-v4-flash-vision-exp')
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.conn.effortName'))
      .setDesc(t('set.conn.effortDesc'))
      .addText((text) =>
        text
          .setPlaceholder('high')
          .setValue(this.plugin.settings.reasoningEffort)
          .onChange(async (value) => {
            this.plugin.settings.reasoningEffort = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.conn.maxTokensName'))
      .setDesc(t('set.conn.maxTokensDesc'))
      .addText((text) =>
        text
          .setPlaceholder('0')
          .setValue(String(this.plugin.settings.maxTokens || 0))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10)
            this.plugin.settings.maxTokens = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.conn.testName'))
      .setDesc(t('set.conn.testDesc'))
      .addButton((button) =>
        button.setButtonText(t('set.conn.testBtn')).onClick(async () => {
          button.setDisabled(true)
          button.setButtonText(t('set.conn.testing'))
          try {
            const runtime = new DshRuntime({
              nodePath: this.plugin.getNodePath(),
              cliPath: this.plugin.getCliPath(),
              profile: this.plugin.settings.profile,
              cwd: this.plugin.getWorkspaceRoot(),
              provider: this.plugin.settings.provider,
              model: this.plugin.settings.model,
              reasoningEffort: this.plugin.settings.reasoningEffort,
              maxTokens: this.plugin.settings.maxTokens,
              dshHome: this.plugin.settings.dshHome,
            })
            const info = await runtime.start()
            const ms = runtime.handshakeMs
            runtime.stop()
            await this.plugin.recordHandshake({
              ok: true,
              at: Date.now(),
              serverInfo: info,
              handshakeMs: ms,
              provider: this.plugin.settings.provider,
              model: this.plugin.settings.model,
              profile: this.plugin.settings.profile,
              cwd: this.plugin.getWorkspaceRoot(),
            })
            new Notice(t('set.conn.testOk', { name: info.name, version: info.version, ms }))
            this.display()
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            await this.plugin.recordHandshake({ ok: false, at: Date.now(), error: message })
            new Notice(t('set.conn.testFail', { title: explainError(error).title }))
            this.display()
          } finally {
            button.setDisabled(false)
            button.setButtonText(t('set.conn.testBtn'))
          }
        }),
      )
  }

  /** 交互区。 */
  renderInteractionSection(containerEl) {
    containerEl.createEl('h3', { text: t('set.interact.heading') })

    new Setting(containerEl)
      .setName(t('set.interact.selModeName'))
      .setDesc(t('set.interact.selModeDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('reference', t('set.interact.selModeRef'))
          .addOption('text', t('set.interact.selModeText'))
          .addOption('both', t('set.interact.selModeBoth'))
          .setValue(this.plugin.settings.selectionMode)
          .onChange(async (value) => {
            this.plugin.settings.selectionMode = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.interact.selActionName'))
      .setDesc(t('set.interact.selActionDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('insert', t('set.interact.selActionInsert'))
          .addOption('send', t('set.interact.selActionSend'))
          .setValue(this.plugin.settings.selectionAction)
          .onChange(async (value) => {
            this.plugin.settings.selectionAction = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName(t('set.interact.toolsName'))
      .setDesc(t('set.interact.toolsDesc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showToolActivity).onChange(async (value) => {
          this.plugin.settings.showToolActivity = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('set.interact.linkName'))
      .setDesc(t('set.interact.linkDesc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.linkifyPaths).onChange(async (value) => {
          this.plugin.settings.linkifyPaths = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName(t('set.interact.reconnectName'))
      .setDesc(t('set.interact.reconnectDesc', { max: MAX_RECONNECT }))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoReconnect).onChange(async (value) => {
          this.plugin.settings.autoReconnect = value
          await this.plugin.saveSettings()
        }),
      )
  }

  /** 诊断区。 */
  renderDiagnosticsSection(containerEl) {
    containerEl.createEl('h3', { text: t('set.diag.heading') })

    const info = this.plugin.getDiagnostics()
    const list = containerEl.createDiv({ cls: 'dsh-diag' })
    for (const [label, value] of info) {
      const row = list.createDiv({ cls: 'dsh-diag-row' })
      row.createSpan({ cls: 'dsh-diag-label', text: label })
      row.createSpan({ cls: 'dsh-diag-value', text: value })
    }

    new Setting(containerEl)
      .setName(t('set.diag.copyName'))
      .setDesc(t('set.diag.copyDesc'))
      .addButton((button) =>
        button.setButtonText(t('set.diag.copyBtn')).onClick(async () => {
          const text = info.map(([label, value]) => `${label}: ${value}`).join('\n')
          await navigator.clipboard.writeText(text)
          new Notice(t('set.diag.copied'))
        }),
      )

    new Setting(containerEl)
      .setName(t('set.diag.clearName'))
      .setDesc(t('set.diag.clearDesc', { max: MAX_TRANSCRIPT }))
      .addButton((button) =>
        button.setButtonText(t('set.diag.clearBtn')).onClick(async () => {
          this.plugin.settings.transcript = null
          await this.plugin.saveSettings()
          new Notice(t('set.diag.cleared'))
        }),
      )
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

class DshPlugin extends Plugin {
  async onload() {
    await this.loadSettings()
    setLanguage(this.settings.language)
    this.transcriptTimer = null

    this.registerView(VIEW_TYPE, (leaf) => new DshView(leaf, this))
    this.addSettingTab(new DshSettingTab(this.app, this))

    this.addRibbonIcon('bot', 'DSH Native', () => void this.activateView())

    this.addCommand({
      id: 'open-panel',
      name: t('panel.openPanelCommand'),
      callback: () => void this.activateView(),
    })

    this.addCommand({
      id: 'send-selection',
      name: t('panel.sendSelectionCommand'),
      editorCallback: async (editor, ctx) => {
        const payload = buildSelectionPayload(editor, ctx.file, this.settings.selectionMode)
        if (!payload) {
          new Notice(t('notice.noSelection'))
          return
        }
        await this.activateView()
        const view = this.getView()
        if (!view) return
        view.prefill(payload)
        if (this.settings.selectionAction === 'send') await view.submit()
      },
    })
  }

  onunload() {
    const view = this.getView()
    if (view) {
      view.clearReconnect()
      view.stopRuntime()
    }
    void this.flushTranscript()
  }

  /** 语言变化后刷新面板。 */
  applyLanguage() {
    setLanguage(this.settings.language)
    const view = this.getView()
    if (view) view.applyLanguage()
  }

  /** 取当前打开的 DSH 面板，没有则返回 null。 */
  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE)
    if (leaves.length === 0) return null
    return leaves[0].view instanceof DshView ? leaves[0].view : null
  }

  /** 在右侧边栏打开（或聚焦）面板。 */
  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0])
      return
    }
    const leaf = this.app.workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: VIEW_TYPE, active: true })
    this.app.workspace.revealLeaf(leaf)
  }

  /** vault 根目录（桌面端）。 */
  getDefaultWorkspaceRoot() {
    const adapter = this.app.vault.adapter
    if (adapter && typeof adapter.getBasePath === 'function') return adapter.getBasePath()
    return process.cwd()
  }

  /** 实际使用的工作区目录。 */
  getWorkspaceRoot() {
    return this.settings.cwd || this.getDefaultWorkspaceRoot()
  }

  /** 解析 node 可执行文件。 */
  getNodePath() {
    if (this.settings.nodePath) return this.settings.nodePath
    return firstExisting(NODE_CANDIDATES, 'node')
  }

  /** 解析 dsh 启动器产物。 */
  getCliPath() {
    if (this.settings.cliPath) return this.settings.cliPath
    return firstExisting(CLI_CANDIDATES, '')
  }

  /** 记录一次握手结果（成功或失败），供诊断区展示。 */
  async recordHandshake(record) {
    this.settings.lastHandshake = record
    await this.saveSettings()
  }

  /** 汇总诊断信息为 [标签, 值] 列表。 */
  getDiagnostics() {
    const settings = this.settings
    const rows = [
      [t('diag.version'), this.manifest.version],
      [t('diag.node'), this.getNodePath()],
      [t('diag.cli'), this.getCliPath() || t('diag.notFound')],
      [t('diag.home'), settings.dshHome || path.join(os.homedir(), '.dsh')],
      [t('diag.profile'), settings.profile],
      [t('diag.cwd'), this.getWorkspaceRoot()],
      [t('diag.route'), `${settings.provider} / ${settings.model}`],
      [t('diag.effort'), settings.reasoningEffort || t('diag.modelDefault')],
      [t('diag.maxTokens'), String(settings.maxTokens || 0)],
    ]
    const last = settings.lastHandshake
    if (!last) {
      rows.push([t('diag.lastHandshake'), t('diag.noHandshake')])
    } else {
      const when = new Date(last.at).toLocaleString()
      const detail = last.ok
        ? t('diag.handshakeOk', {
            when,
            ms: last.handshakeMs ? t('diag.handshakeMs', { ms: last.handshakeMs }) : '',
            server: last.serverInfo ? t('diag.handshakeServer', { name: last.serverInfo.name, version: last.serverInfo.version }) : '',
          })
        : t('diag.handshakeFail', { when, error: truncate(last.error || '', 160) })
      rows.push([t('diag.lastHandshake'), detail])
    }
    const view = this.getView()
    rows.push([
      t('diag.runtime'),
      view && view.runtime && view.runtime.alive ? t('diag.running') : t('diag.notRunning'),
    ])
    return rows
  }

  /** 跑一次环境检测并用通知简报结果。 */
  async runEnvironmentCheckAndReport() {
    const results = await checkEnvironment(this)
    const bad = results.filter((r) => r.status === 'fail')
    if (bad.length === 0) {
      new Notice(t('env.report.ok'))
    } else {
      new Notice(t('env.report.fail', { count: bad.length, names: bad.map((b) => b.name).join(', ') }))
    }
    return results
  }

  /** 防抖保存面板记录。 */
  queueTranscriptSave(messages) {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer)
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null
      void this.flushTranscript(messages)
    }, 800)
  }

  /** 立即把面板记录写进 data.json。 */
  async flushTranscript(messages) {
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer)
      this.transcriptTimer = null
    }
    const view = this.getView()
    const list = messages || (view ? view.transcript : null)
    if (!list) return
    this.settings.transcript = { messages: list.slice(-MAX_TRANSCRIPT), savedAt: Date.now() }
    await this.saveSettings()
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
}

module.exports = DshPlugin
// 便于在 Obsidian 之外做协议冒烟测试与逻辑回归测试（见 dev/）；
// 不影响 Obsidian 把 module.exports 当插件类加载。
module.exports.DshRuntime = DshRuntime
module.exports.DshView = DshView
module.exports.explainError = explainError
module.exports.buildSelectionPayload = buildSelectionPayload
module.exports.buildSelectionReference = buildSelectionReference
module.exports.checkEnvironment = checkEnvironment
module.exports.linkifyVaultPaths = linkifyVaultPaths
module.exports.setLanguage = setLanguage
module.exports.getLanguage = getLanguage
module.exports.DICT = DICT
module.exports.ERR = ERR
