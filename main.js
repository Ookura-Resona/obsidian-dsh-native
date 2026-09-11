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
const ACTION_LABELS = {
  retry: '重试',
  settings: '打开设置',
  check: '检测环境',
  restart: '重启运行时',
  newSession: '开新会话',
}

/**
 * 把原始错误翻译成「标题 + 说明 + 排查建议 + 可点动作」。
 *
 * 用户看到 `spawn ENOENT` 是没法自救的，得告诉他到底缺什么、下一步点哪里。
 *
 * @param {unknown} error
 * @returns {{ title: string, detail: string, hints: string[], actions: string[] }}
 */
function explainError(error) {
  const message = error && error.message ? String(error.message) : String(error || '')
  const lower = message.toLowerCase()

  if (isSessionExistsError(error)) {
    return {
      title: '会话 id 已被占用',
      detail: message,
      hints: [
        '这通常发生在运行时进程重启后复用了旧会话 id —— DSH 协议不支持跨进程续接会话。',
        '插件已经会自动换一个新会话 id 重试；若仍失败，点下面的「开新会话」。',
      ],
      actions: ['newSession', 'restart'],
    }
  }

  if (/enoent/.test(lower)) {
    return {
      title: '找不到 node 可执行文件',
      detail: message,
      hints: [
        '在设置里把「node 可执行文件」填成绝对路径，例如 C:\\Program Files\\nodejs\\node.exe',
        '确认 Node.js 已安装，且路径没有写错。',
      ],
      actions: ['settings', 'check'],
    }
  }

  if (/未找到 dsh cli 产物/.test(lower)) {
    return {
      title: '没找到 dsh 的构建产物（bin.js）',
      detail: message,
      hints: [
        '在 deepseek-harness 仓库里执行 pnpm install 然后 pnpm run build。',
        '然后在设置里把「dsh CLI 产物」指向 apps/cli/lib/bin.js。',
      ],
      actions: ['settings', 'check'],
    }
  }

  if (/no adapter registered for provider/.test(lower)) {
    return {
      title: 'provider 名称不被识别',
      detail: message,
      hints: [
        'provider 必须与 DSH 已注册的适配器一致；deepseek-official 内置可用。',
        '检查设置里的 provider / model 拼写。',
      ],
      actions: ['settings'],
    }
  }

  if (/initialize 超时/.test(message)) {
    return {
      title: 'initialize 握手超时',
      detail: message,
      hints: [
        '首次使用 sdk profile 时 DSH 要从随附模板自举，可能需要几十秒到几分钟。',
        '也可能是同时在启动多个实例；稍等后重试或重启运行时。',
      ],
      actions: ['restart', 'check'],
    }
  }

  if (/运行时已退出/.test(message)) {
    return {
      title: 'dsh 运行时进程退出了',
      detail: message,
      hints: [
        '进程可能因为配置错误或环境问题崩溃。',
        '点「重启运行时」可以重新拉起；开了自动重连时插件也会自己重试。',
      ],
      actions: ['restart', 'check'],
    }
  }

  if (/credential|api key|unauthorized|401|authentication/i.test(message)) {
    return {
      title: '凭据相关问题',
      detail: message,
      hints: [
        'DSH 的凭据从环境变量、$DSH_HOME/.credentials.yaml 或 .env 解析。',
        '确认已配置可用的 API key；插件本身不读取也不转发密钥。',
      ],
      actions: ['check'],
    }
  }

  if (/eperm|eacces/.test(lower)) {
    return {
      title: '权限被拒绝',
      detail: message,
      hints: [
        '检查 node 与 dsh 仓库目录的读取权限。',
        'Windows 上若仓库位于受保护目录，可能被系统策略拦下。',
      ],
      actions: ['check'],
    }
  }

  return {
    title: '出错了',
    detail: message || '（没有更多信息）',
    hints: ['可以点「检测环境」看各项配置是否正常，或「重启运行时」重来一次。'],
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
  const reference = `[选中片段] 文件：${file.path}｜范围：第 ${from.line + 1} 行第 ${from.ch + 1} 列 → 第 ${to.line + 1} 行第 ${to.ch + 1} 列（共 ${selected.length} 字符）｜请读取该文件对应范围后处理`

  return mode === 'both' ? `${reference}\n\n原文如下：\n${selected}` : reference
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
      this._failAll(new Error(`无法启动 dsh 子进程：${error.message}`))
    })
    this.child.on('exit', (code, signal) => {
      const wasStopped = this.stopped
      this._failAll(new Error(`dsh 运行时已退出（code=${code}, signal=${signal}）`))
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
        reject(new Error('dsh 运行时未运行'))
        return
      }
      const id = this.nextId++
      const timer = timeoutMs
        ? setTimeout(() => {
            if (this.pending.delete(id)) reject(new Error(`${method} 超时（${timeoutMs}ms）`))
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
    this._failAll(new Error('dsh 运行时已被用户停止'))
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
        const text = message.error.message === undefined ? '未知错误' : message.error.message
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
    this.statusEl = status.createSpan({ text: '未连接' })

    this.actionsEl = header.createDiv({ cls: 'dsh-header-actions' })

    const newBtn = this.actionsEl.createEl('button', { text: '新会话' })
    newBtn.onclick = () => this.newSession()
    const restartBtn = this.actionsEl.createEl('button', { text: '重启' })
    restartBtn.onclick = () => void this.restartRuntime()
    const insertBtn = this.actionsEl.createEl('button', { text: '存入笔记' })
    insertBtn.onclick = () => void this.insertIntoNote()
    const stopBtn = this.actionsEl.createEl('button', { text: '停止' })
    stopBtn.onclick = () => this.stopRuntime()

    // ---- 消息区 ----
    this.messagesEl = root.createDiv({ cls: 'dsh-messages' })
    if (!this.restoreTranscript()) this.renderEmpty()

    // ---- 输入区 ----
    const inputRow = root.createDiv({ cls: 'dsh-input-row' })
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'dsh-input',
      attr: { placeholder: '问点什么，或让 agent 直接改你的笔记…（Enter 发送，Shift+Enter 换行）' },
    })
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void this.submit()
      }
    })
    const actions = inputRow.createDiv({ cls: 'dsh-input-actions' })
    const hint = actions.createDiv({ cls: 'dsh-hint' })
    hint.setText(`工作区：${this.plugin.getWorkspaceRoot()}`)
    const sendBtn = actions.createEl('button', { text: '发送', cls: 'mod-cta' })
    sendBtn.onclick = () => void this.submit()
  }

  async onClose() {
    this.clearReconnect()
    this.stopRuntime()
    await this.plugin.flushTranscript()
  }

  /* ---------------- 渲染 ---------------- */

  /** 面板内的空状态提示。 */
  renderEmpty() {
    this.messagesEl.empty()
    const empty = this.messagesEl.createDiv({ cls: 'dsh-empty' })
    empty.createDiv({ text: 'DSH Native 尚未连接。' })
    empty.createDiv({ text: '直接输入问题并按 Enter，插件会自动启动运行时。' })
    empty.createDiv({ text: 'agent 以 vault 为工作目录，可直接读写笔记。' })
  }

  /** 从持久化数据恢复上次的对话记录（仅用于阅读）。 */
  restoreTranscript() {
    const saved = this.plugin.settings.transcript
    if (!saved || !Array.isArray(saved.messages) || saved.messages.length === 0) return false
    this.transcript = saved.messages.slice()
    this.messagesEl.empty()
    this.appendNotice('已恢复上次的对话记录。DSH 协议不支持跨进程续接上下文，请直接提新问题或点「新会话」。')
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
        const label = ACTION_LABELS[action]
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
          new Notice('请手动打开：设置 → 第三方插件 → DSH Native')
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
      throw new Error('未找到 dsh CLI 产物。请在插件设置里填写 bin.js 的绝对路径。')
    }

    // 新进程无法复用旧会话 id（会话已持久化，create 会拒绝），必须换新 id
    const wasRunning = this.sessionUsed
    this.sessionId = mintSessionId()
    if (wasRunning) {
      this.pushEntry({ role: 'notice', text: '运行时已重启：已自动开启新会话（DSH 协议不支持跨进程续接上下文）' })
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

    this.setStatus('正在启动 dsh 运行时…', 'running')
    const info = await runtime.start()
    this.runtime = runtime
    this.sessionUsed = false
    this.reconnectAttempts = 0
    this.setStatus(`已连接 ${info.name}`, null)
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
    this.setStatus(`运行时已退出（code=${code}）`, 'error')
    this.pushEntry({ role: 'notice', text: `dsh 运行时已退出（code=${code}）` })
    this.showErrorCard(new Error(`dsh 运行时已退出（code=${code}）`))
    void this.plugin.recordHandshake({ ok: false, at: Date.now(), error: `运行时退出 code=${code}` })

    if (!this.plugin.settings.autoReconnect || this.userStopped) return
    if (this.reconnectAttempts >= MAX_RECONNECT) {
      this.pushEntry({ role: 'notice', text: `已连续重连 ${MAX_RECONNECT} 次仍未成功，请点「检测环境」排查。` })
      return
    }
    this.reconnectAttempts += 1
    const delayMs = 1000 * 2 ** (this.reconnectAttempts - 1)
    this.pushEntry({ role: 'notice', text: `${Math.round(delayMs / 1000)} 秒后自动重连（第 ${this.reconnectAttempts}/${MAX_RECONNECT} 次）…` })
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
      this.pushEntry({ role: 'notice', text: '已重连。' })
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
    this.setStatus('正在重启…', 'running')
    try {
      await this.ensureRuntime()
      this.pushEntry({ role: 'notice', text: '运行时已重启。' })
    } catch (error) {
      this.setStatus('重启失败', 'error')
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
    this.setStatus('已停止', null)
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
        this.setStatus('运行中…', 'running')
        if (this.turnWaiter) this.turnWaiter.sawRunning = true
      } else if (params.status === 'idle') {
        this.setStatus('就绪', null)
        this.maybeFinishTurn()
      }
      return
    }

    if (method === 'subagent.started') {
      if (params.parentSessionId !== this.sessionId && params.childSessionId !== this.sessionId) return
      this.pushEntry({ role: 'tool', text: '↳ 子 agent 启动' })
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
        this.pushEntry({ role: 'tool', text: `🔧 ${name} ${truncate(squeeze(args), 160)}` })
        return
      }
      case 'tool/result': {
        if (!this.plugin.settings.showToolActivity) return
        if (data.error) {
          const detail = `${data.error.name || 'error'}: ${data.error.code || ''}`
          this.pushEntry({ role: 'tool', text: `✗ ${truncate(detail, 160)}`, error: true })
        }
        return
      }
      case 'turn/end': {
        this.reportTurnEnd(data.reason)
        this.maybeFinishTurn()
        return
      }
      case 'compaction/summary': {
        this.pushEntry({ role: 'notice', text: '上下文已压缩' })
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
      detail = '达到输出上限'
    } else if (kind === 'aborted' && reason.reason) {
      detail = typeof reason.reason === 'object' ? reason.reason.kind || '' : String(reason.reason)
    }
    this.pushEntry({ role: 'notice', text: `本轮结束：${kind}${detail ? `（${detail}）` : ''}` })
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
        this.pushEntry({ role: 'notice', text: '会话 id 冲突，已自动换用新会话重试。' })
        runtime = await this.ensureRuntime()
        await runtime.prompt(this.sessionId, text)
      }
      this.sessionUsed = true
      this.setStatus('运行中…', 'running')
      await turn
      this.setStatus('就绪', null)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.setStatus('出错', 'error')
      this.pushEntry({ role: 'notice', text: `出错：${truncate(message, 300)}` })
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
    this.setStatus(this.runtime && this.runtime.alive ? '就绪（新会话）' : '未连接', null)
  }

  /** 把最后一条助手消息追加到当前笔记。 */
  async insertIntoNote() {
    if (!this.lastAnswer) {
      new Notice('还没有可存入的回复')
      return
    }
    const file = this.app.workspace.getActiveFile()
    if (!file) {
      await navigator.clipboard.writeText(this.lastAnswer)
      new Notice('没有活动笔记，已复制到剪贴板')
      return
    }
    const existing = await this.app.vault.read(file)
    const separator = existing.endsWith('\n') ? '\n' : '\n\n'
    await this.app.vault.modify(file, `${existing}${separator}${this.lastAnswer}\n`)
    new Notice(`已存入 ${file.basename}`)
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
    results.push({ name: 'Node.js', status: 'ok', detail: `${nodePath} -> ${version}` })
  } catch (error) {
    results.push({
      name: 'Node.js',
      status: 'fail',
      detail: `${nodePath} 无法执行：${error && error.message ? error.message : String(error)}`,
      fix: '在设置里把「node 可执行文件」填成绝对路径，例如 C:\\Program Files\\nodejs\\node.exe',
    })
  }

  // 2) dsh CLI 产物
  const cliPath = plugin.getCliPath()
  if (cliPath && fs.existsSync(cliPath)) {
    results.push({ name: 'dsh CLI 产物', status: 'ok', detail: cliPath })
  } else {
    results.push({
      name: 'dsh CLI 产物',
      status: 'fail',
      detail: cliPath ? `文件不存在：${cliPath}` : '未找到 bin.js',
      fix: '在 deepseek-harness 仓库里执行 pnpm install 与 pnpm run build，然后在设置里指定 apps/cli/lib/bin.js',
    })
  }

  // 3) 工作区目录
  const cwd = plugin.getWorkspaceRoot()
  try {
    const stat = fs.statSync(cwd)
    results.push({
      name: '工作区目录',
      status: stat.isDirectory() ? 'ok' : 'fail',
      detail: cwd,
      fix: stat.isDirectory() ? undefined : '这个路径不是目录',
    })
  } catch {
    results.push({
      name: '工作区目录',
      status: 'fail',
      detail: `不存在：${cwd}`,
      fix: '在设置里改成存在的目录，或留空使用 vault 根目录',
    })
  }

  // 4) DSH_HOME
  const dshHome = settings.dshHome || path.join(os.homedir(), '.dsh')
  if (fs.existsSync(dshHome)) {
    results.push({ name: 'DSH_HOME', status: 'ok', detail: dshHome })
  } else {
    results.push({
      name: 'DSH_HOME',
      status: 'warn',
      detail: `尚不存在：${dshHome}`,
      fix: '首次启动 sdk profile 时 DSH 会自动创建，无需手动处理',
    })
  }

  // 5) profile 目录
  const profileDir = path.join(dshHome, 'profiles', settings.profile || 'sdk')
  results.push(
    fs.existsSync(profileDir)
      ? { name: `profile「${settings.profile}」`, status: 'ok', detail: profileDir }
      : {
          name: `profile「${settings.profile}」`,
          status: 'warn',
          detail: `尚未初始化：${profileDir}`,
          fix: '首次启动会自动从随附模板初始化，可能耗时几十秒',
        },
  )

  // 6) 凭据（只看是否存在，绝不读取内容）
  const credFile = path.join(dshHome, '.credentials.yaml')
  const hasEnvKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (hasEnvKey) {
    results.push({ name: '模型凭据', status: 'ok', detail: '检测到环境变量 DEEPSEEK_API_KEY（插件不读取其值）' })
  } else if (fs.existsSync(credFile)) {
    results.push({ name: '模型凭据', status: 'ok', detail: `存在 ${credFile}（插件不读取其内容）` })
  } else {
    results.push({
      name: '模型凭据',
      status: 'warn',
      detail: `未在环境变量或 ${credFile} 里发现凭据`,
      fix: '按 DSH 的凭据方式配置 API key（插件本身不接触密钥）',
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
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '插件以 sdk profile 启动 dsh 子进程，并用换行分帧的 JSON-RPC 驱动它。留空的路径项会自动探测。',
    })

    this.renderEnvironmentSection(containerEl)
    this.renderConnectionSection(containerEl)
    this.renderInteractionSection(containerEl)
    this.renderDiagnosticsSection(containerEl)
  }

  /** 环境检测区。 */
  renderEnvironmentSection(containerEl) {
    containerEl.createEl('h3', { text: '环境' })

    this.envResultEl = containerEl.createDiv({ cls: 'dsh-env-list' })

    new Setting(containerEl)
      .setName('检测环境')
      .setDesc('逐项检查 node、dsh 产物、工作区、DSH_HOME、profile 与凭据。只检测，不自动安装任何东西。')
      .addButton((button) =>
        button.setButtonText('开始检测').onClick(async () => {
          button.setDisabled(true)
          button.setButtonText('检测中…')
          this.envResultEl.empty()
          try {
            const results = await checkEnvironment(this.plugin)
            this.renderEnvResults(results)
          } catch (error) {
            this.envResultEl.createDiv({ text: `检测失败：${error && error.message ? error.message : String(error)}` })
          } finally {
            button.setDisabled(false)
            button.setButtonText('开始检测')
          }
        }),
      )

    new Setting(containerEl)
      .setName('dsh CLI 产物（bin.js）')
      .setDesc('指向仓库里构建好的启动器，例如 <你的仓库>\\apps\\cli\\lib\\bin.js')
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
        button.setButtonText('自动探测').onClick(async () => {
          const found = firstExisting(CLI_CANDIDATES, '')
          if (found) {
            this.plugin.settings.cliPath = found
            await this.plugin.saveSettings()
            new Notice(`已找到：${found}`)
          } else {
            new Notice('未在常见位置找到 bin.js，请手动填写')
          }
          this.display()
        }),
      )

    new Setting(containerEl)
      .setName('node 可执行文件')
      .setDesc('留空则自动探测，仍找不到时回退为 PATH 上的 node。')
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
      .setName('工作区目录（cwd）')
      .setDesc('作为 initialize 的 cwd，也就是 agent 的工作区根目录。留空 = vault 根目录；写入被沙箱限制在此目录内。')
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
      .setName('DSH_HOME')
      .setDesc('留空 = 沿用 dsh 默认值（~/.dsh）。仅当你的配置目录不在默认位置时才需要填写。')
      .addText((text) =>
        text
          .setPlaceholder(path.join(os.homedir(), '.dsh'))
          .setValue(this.plugin.settings.dshHome)
          .onChange(async (value) => {
            this.plugin.settings.dshHome = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl).setName('profile').addText((text) =>
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
      if (item.fix) body.createDiv({ cls: 'dsh-env-fix', text: `建议：${item.fix}` })
    }
    const bad = results.filter((r) => r.status === 'fail').length
    const warn = results.filter((r) => r.status === 'warn').length
    const summary = bad === 0
      ? (warn === 0 ? '全部正常。' : `${warn} 项需要留意（多数首次启动会自动解决）。`)
      : `${bad} 项失败，按上面的建议处理后重试。`
    el.createDiv({ cls: 'dsh-env-summary', text: summary })
  }

  /** 连接与模型路由区。 */
  renderConnectionSection(containerEl) {
    containerEl.createEl('h3', { text: '连接与模型路由' })

    new Setting(containerEl)
      .setName('provider')
      .setDesc('必须与 DSH 已注册的适配器一致；deepseek-official 内置可用。')
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
      .setName('model')
      .setDesc('握手时会由适配器校验该路由；不可用会直接报错，不会静默回退。')
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
      .setName('reasoning effort')
      .setDesc('可选，由适配器持有。留空则用模型默认值。')
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
      .setName('max tokens')
      .setDesc('每次模型输出的上限；0 表示用模型默认值。')
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
      .setName('测试连接')
      .setDesc('启动一次运行时并完成 initialize 握手，用来验证上面的配置。')
      .addButton((button) =>
        button.setButtonText('测试').onClick(async () => {
          button.setDisabled(true)
          button.setButtonText('测试中…')
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
            new Notice(`连接成功：${info.name} v${info.version}（${ms}ms）`)
            this.display()
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            await this.plugin.recordHandshake({ ok: false, at: Date.now(), error: message })
            new Notice(`连接失败：${explainError(error).title}`)
            this.display()
          } finally {
            button.setDisabled(false)
            button.setButtonText('测试')
          }
        }),
      )
  }

  /** 交互区。 */
  renderInteractionSection(containerEl) {
    containerEl.createEl('h3', { text: '交互' })

    new Setting(containerEl)
      .setName('框选发送的内容')
      .setDesc('命令「把选中内容发给 DSH」发什么。发送文件位置引用可让 agent 自己读文件，比贴原文更省 token，也能处理非整行选区。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('reference', '只发文件位置引用（推荐）')
          .addOption('text', '只发选中的原文')
          .addOption('both', '引用 + 原文')
          .setValue(this.plugin.settings.selectionMode)
          .onChange(async (value) => {
            this.plugin.settings.selectionMode = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('框选后')
      .setDesc('插入输入框可以让你先补一句要求再发送；直接发送更省事。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('insert', '插入输入框，等我编辑')
          .addOption('send', '直接发送')
          .setValue(this.plugin.settings.selectionAction)
          .onChange(async (value) => {
            this.plugin.settings.selectionAction = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('显示工具调用')
      .setDesc('在对话里显示 🔧 工具名等紧凑活动行。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showToolActivity).onChange(async (value) => {
          this.plugin.settings.showToolActivity = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('笔记路径可点击')
      .setDesc('把回复里出现的 vault 内路径渲染成链接，点击直接在 Obsidian 打开（支持 path.md:行号 定位）。')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.linkifyPaths).onChange(async (value) => {
          this.plugin.settings.linkifyPaths = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('崩溃后自动重连')
      .setDesc(`运行时意外退出时自动重试，最多 ${MAX_RECONNECT} 次（指数退避）。注意：重连后上下文会重置 —— 协议不支持跨进程续接会话。`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoReconnect).onChange(async (value) => {
          this.plugin.settings.autoReconnect = value
          await this.plugin.saveSettings()
        }),
      )
  }

  /** 诊断区。 */
  renderDiagnosticsSection(containerEl) {
    containerEl.createEl('h3', { text: '诊断' })

    const info = this.plugin.getDiagnostics()
    const list = containerEl.createDiv({ cls: 'dsh-diag' })
    for (const [label, value] of info) {
      const row = list.createDiv({ cls: 'dsh-diag-row' })
      row.createSpan({ cls: 'dsh-diag-label', text: label })
      row.createSpan({ cls: 'dsh-diag-value', text: value })
    }

    new Setting(containerEl)
      .setName('复制诊断信息')
      .setDesc('把上面的解析结果与最近一次握手记录复制到剪贴板，便于排查问题时贴出来。')
      .addButton((button) =>
        button.setButtonText('复制').onClick(async () => {
          const text = info.map(([label, value]) => `${label}: ${value}`).join('\n')
          await navigator.clipboard.writeText(text)
          new Notice('已复制诊断信息')
        }),
      )

    new Setting(containerEl)
      .setName('清空面板记录')
      .setDesc(`面板会保留最近 ${MAX_TRANSCRIPT} 条对话用于重载后查看（仅记录，不含上下文）。`)
      .addButton((button) =>
        button.setButtonText('清空').onClick(async () => {
          this.plugin.settings.transcript = null
          await this.plugin.saveSettings()
          new Notice('已清空面板记录')
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
    this.transcriptTimer = null

    this.registerView(VIEW_TYPE, (leaf) => new DshView(leaf, this))
    this.addSettingTab(new DshSettingTab(this.app, this))

    this.addRibbonIcon('bot', 'DSH Native', () => void this.activateView())

    this.addCommand({
      id: 'open-panel',
      name: '打开对话面板',
      callback: () => void this.activateView(),
    })

    this.addCommand({
      id: 'send-selection',
      name: '把选中内容发给 DSH',
      editorCallback: async (editor, ctx) => {
        const payload = buildSelectionPayload(editor, ctx.file, this.settings.selectionMode)
        if (!payload) {
          new Notice('没有选中内容')
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
      ['插件版本', this.manifest.version],
      ['node', this.getNodePath()],
      ['dsh CLI 产物', this.getCliPath() || '（未找到）'],
      ['DSH_HOME', settings.dshHome || path.join(os.homedir(), '.dsh')],
      ['profile', settings.profile],
      ['工作区目录', this.getWorkspaceRoot()],
      ['provider / model', `${settings.provider} / ${settings.model}`],
      ['reasoning effort', settings.reasoningEffort || '（模型默认）'],
      ['max tokens', String(settings.maxTokens || 0)],
    ]
    const last = settings.lastHandshake
    if (!last) {
      rows.push(['最近一次握手', '（本机还没有记录）'])
    } else {
      const when = new Date(last.at).toLocaleString()
      const detail = last.ok
        ? `成功 · ${when}${last.handshakeMs ? ` · 耗时 ${last.handshakeMs}ms` : ''}${last.serverInfo ? ` · ${last.serverInfo.name} v${last.serverInfo.version}` : ''}`
        : `失败 · ${when} · ${truncate(last.error || '', 160)}`
      rows.push(['最近一次握手', detail])
    }
    const view = this.getView()
    rows.push(['面板运行时', view && view.runtime && view.runtime.alive ? '运行中' : '未运行'])
    return rows
  }

  /** 跑一次环境检测并用通知简报结果。 */
  async runEnvironmentCheckAndReport() {
    const results = await checkEnvironment(this)
    const bad = results.filter((r) => r.status === 'fail')
    if (bad.length === 0) {
      new Notice('环境检测：没有发现致命问题（详情见插件设置页）')
    } else {
      new Notice(`环境检测：${bad.length} 项失败 —— ${bad.map((b) => b.name).join('、')}（详情见插件设置页）`)
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
module.exports.checkEnvironment = checkEnvironment
module.exports.linkifyVaultPaths = linkifyVaultPaths
