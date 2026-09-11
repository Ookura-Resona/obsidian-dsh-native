/*
 * dsh-harness — 把 DeepSeek Harness 作为 AI 协作者嵌进 Obsidian。
 *
 * 工作原理
 * --------
 * 插件以子进程方式启动 dsh 运行时的 `sdk` profile：
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
 * 多轮对话靠复用同一个 `sessionId`：服务端对同一 id 做 getOrCreateSession，
 * 所以后续 session/prompt 会接着同一个 agent 的上下文继续。
 *
 * 已知限制（协议本身的边界，不是本插件的 bug）
 * -------------------------------------------
 * 1. 协议层没有「取消本轮」方法 —— 「停止」只能关掉整个运行时进程。
 * 2. 协议层没有客户端/服务端反向请求，因此无法应答审批弹窗。工作区内的
 *    写入本来就无需审批；一旦某操作需要提权，它会 fail closed。
 * 3. 流式增量（assistant/attempt 的 stream 记录）本插件不重建，助手消息在
 *    每个 step 结束时整段呈现。
 */

'use strict'

const obsidian = require('obsidian')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { randomUUID } = require('crypto')

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownRenderer } = obsidian

const VIEW_TYPE = 'dsh-harness-view'

/** 一轮对话的兜底等待上限（毫秒）。 */
const TURN_TIMEOUT_MS = 30 * 60 * 1000

/** 启动 + initialize 握手的等待上限（毫秒）：首次会初始化 profile，给足时间。 */
const INIT_TIMEOUT_MS = 3 * 60 * 1000

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

    const result = await this.request('initialize', params, INIT_TIMEOUT_MS)
    this.serverInfo = result && result.serverInfo ? result.serverInfo : { name: 'unknown', version: 'unknown' }
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
    // stdin EOF → SIGTERM → SIGKILL 阶梯
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
    this.sessionId = `session-${randomUUID().replaceAll('-', '')}`
    this.turnWaiter = null
    this.lastAnswer = ''
    this.busy = false
  }

  getViewType() {
    return VIEW_TYPE
  }

  getDisplayText() {
    return 'DeepSeek Harness'
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

    const newBtn = header.createEl('button', { text: '新会话' })
    newBtn.onclick = () => this.newSession()
    const insertBtn = header.createEl('button', { text: '存入笔记' })
    insertBtn.onclick = () => this.insertIntoNote()
    this.stopBtn = header.createEl('button', { text: '停止' })
    this.stopBtn.onclick = () => this.stopRuntime()

    // ---- 消息区 ----
    this.messagesEl = root.createDiv({ cls: 'dsh-messages' })
    this.renderEmpty()

    // ---- 输入区 ----
    const inputRow = root.createDiv({ cls: 'dsh-input-row' })
    this.inputEl = inputRow.createEl('textarea', {
      cls: 'dsh-input',
      attr: { placeholder: '问点什么，或让 agent 直接改你的笔记…（Enter 发送，Shift+Enter 换行）' },
    })
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.submit()
      }
    })
    const actions = inputRow.createDiv({ cls: 'dsh-input-actions' })
    const hint = actions.createDiv({ cls: 'dsh-hint' })
    hint.setText(`工作区：${this.plugin.getWorkspaceRoot()}`)
    const sendBtn = actions.createEl('button', { text: '发送', cls: 'mod-cta' })
    sendBtn.onclick = () => this.submit()
  }

  async onClose() {
    this.stopRuntime()
  }

  /** 面板内的空状态提示。 */
  renderEmpty() {
    this.messagesEl.empty()
    const empty = this.messagesEl.createDiv({ cls: 'dsh-empty' })
    empty.createDiv({ text: 'DeepSeek Harness 尚未连接。' })
    empty.createDiv({ text: '直接输入问题并按 Enter，插件会自动启动运行时。' })
    empty.createDiv({ text: 'agent 以 vault 为工作目录，可直接读写笔记。' })
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

  /** 确保运行时已就绪；返回 runtime 或抛出错误。 */
  async ensureRuntime() {
    if (this.runtime && this.runtime.alive) return this.runtime

    const settings = this.plugin.settings
    const nodePath = this.plugin.getNodePath()
    const cliPath = this.plugin.getCliPath()
    if (!cliPath) {
      throw new Error('未找到 dsh CLI 产物。请在插件设置里填写 bin.js 的绝对路径。')
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
      onExit: (code) => {
        this.setStatus(`运行时已退出（code=${code}）`, 'error')
        this.appendNotice(`dsh 运行时已退出（code=${code}）。下次发送会自动重启。`)
      },
    })

    this.setStatus('正在启动 dsh 运行时…', 'running')
    const info = await runtime.start()
    this.runtime = runtime
    this.setStatus(`已连接 ${info.name}`, null)
    return runtime
  }

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
      this.appendToolLine('↳ 子 agent 启动', false)
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
          this.appendAssistant(text)
        }
        return
      }
      case 'tool/call': {
        if (!this.plugin.settings.showToolActivity) return
        const name = data.name || 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : ''
        this.appendToolLine(`🔧 ${name} ${truncate(squeeze(args), 160)}`, false)
        return
      }
      case 'tool/result': {
        if (!this.plugin.settings.showToolActivity) return
        if (data.error) {
          const detail = `${data.error.name || 'error'}: ${data.error.code || ''}`
          this.appendToolLine(`✗ ${truncate(detail, 160)}`, true)
        }
        return
      }
      case 'turn/end': {
        this.reportTurnEnd(data.reason)
        this.maybeFinishTurn()
        return
      }
      case 'compaction/summary': {
        this.appendNotice('上下文已压缩')
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
    this.appendNotice(`本轮结束：${kind}${detail ? `（${detail}）` : ''}`)
  }

  /** 把 stderr 的推理/错误行转成提示（只挑有信息量的行，避免刷屏）。 */
  appendNoticeIfUseful(text) {
    if (!text) return
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('dsh: reasoning:')) continue // 推理增量太碎，不逐条铺进面板
      if (line.startsWith('dsh:')) {
        this.appendNotice(line)
      }
    }
  }

  appendUser(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-msg dsh-msg-user' })
    el.setText(text)
    this.scrollToBottom()
  }

  appendAssistant(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-msg dsh-msg-assistant' })
    try {
      if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
        const rendered = MarkdownRenderer.render(this.app, text, el, '', this)
        // render 返回 promise：异步失败时回退成纯文本，避免静默空白
        if (rendered && typeof rendered.catch === 'function') {
          rendered.catch(() => el.setText(text))
        }
      } else {
        el.setText(text)
      }
    } catch {
      el.setText(text)
    }
    this.scrollToBottom()
  }

  appendToolLine(text, isError) {
    const el = this.messagesEl.createDiv({ cls: isError ? 'dsh-tool is-error' : 'dsh-tool' })
    el.setText(text)
    this.scrollToBottom()
  }

  appendNotice(text) {
    const el = this.messagesEl.createDiv({ cls: 'dsh-notice-line' })
    el.setText(text)
    this.scrollToBottom()
  }

  /**
   * 开始等待本轮结束。
   *
   * 判定条件：必须先在 `session.status` 上观察到 `running`，之后收到
   * `turn/end` 或 `running → idle` 才算结束。要求 `sawRunning` 是为了排除
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

  /** 发送输入框里的内容。 */
  async submit() {
    const text = this.inputEl.value.trim()
    if (!text || this.busy) return

    this.busy = true
    this.inputEl.value = ''
    // 先摘掉空状态提示，再追加用户消息（顺序反了会把用户消息一起清掉）
    const emptyState = this.messagesEl.querySelector('.dsh-empty')
    if (emptyState) emptyState.remove()
    this.appendUser(text)
    // 在 prompt 之前就登记本轮，避免极快的回合在收到回执前就结束
    const turn = this.beginTurn()

    try {
      const runtime = await this.ensureRuntime()
      await runtime.prompt(this.sessionId, text)
      this.setStatus('运行中…', 'running')
      await turn
      this.setStatus('就绪', null)
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      this.appendNotice(`出错：${message}`)
      this.setStatus('出错', 'error')
      new Notice(`DeepSeek Harness：${message}`)
    } finally {
      this.finishTurn()
      this.busy = false
    }
  }

  /** 开一个新会话（同一运行时进程内换一个 sessionId）。 */
  newSession() {
    this.finishTurn()
    this.sessionId = `session-${randomUUID().replaceAll('-', '')}`
    this.lastAnswer = ''
    this.renderEmpty()
    this.setStatus(this.runtime && this.runtime.alive ? '就绪（新会话）' : '未连接', null)
  }

  /** 停止运行时（协议层没有逐轮取消，只能关进程）。 */
  stopRuntime() {
    this.finishTurn()
    if (this.runtime) {
      this.runtime.stop()
      this.runtime = null
    }
    this.setStatus('已停止', null)
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

    containerEl.createEl('h2', { text: 'DeepSeek Harness' })
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '插件以 sdk profile 启动 dsh 子进程，并使用换行分帧的 JSON-RPC 驱动它。留空的路径项会自动探测。',
    })

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

    containerEl.createEl('h3', { text: '模型路由' })

    new Setting(containerEl).setName('provider').addText((text) =>
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

    containerEl.createEl('h3', { text: '界面' })

    new Setting(containerEl).setName('显示工具调用').setDesc('在对话里显示 🔧 工具名等紧凑活动行。').addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showToolActivity).onChange(async (value) => {
        this.plugin.settings.showToolActivity = value
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
            runtime.stop()
            new Notice(`连接成功：${info.name} v${info.version}`)
          } catch (error) {
            const message = error && error.message ? error.message : String(error)
            new Notice(`连接失败：${message}`)
            console.error('[dsh-harness] 连接测试失败', error)
          } finally {
            button.setDisabled(false)
            button.setButtonText('测试')
          }
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

    this.registerView(VIEW_TYPE, (leaf) => new DshView(leaf, this))
    this.addSettingTab(new DshSettingTab(this.app, this))

    this.addRibbonIcon('bot', 'DeepSeek Harness', () => this.activateView())

    this.addCommand({
      id: 'open-panel',
      name: '打开对话面板',
      callback: () => this.activateView(),
    })

    this.addCommand({
      id: 'send-selection',
      name: '把选中内容发给 DSH',
      editorCallback: async (editor) => {
        const selection = editor.getSelection() || editor.getValue()
        if (!selection.trim()) {
          new Notice('没有选中内容')
          return
        }
        await this.activateView()
        const view = this.getView()
        if (view) {
          view.inputEl.value = selection
          await view.submit()
        }
      },
    })
  }

  onunload() {
    const view = this.getView()
    if (view) view.stopRuntime()
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }
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

module.exports = DshPlugin
// 便于在 Obsidian 之外做协议冒烟测试/复用；不影响 Obsidian 把 module.exports 当插件类加载
module.exports.DshRuntime = DshRuntime
module.exports.DshView = DshView
