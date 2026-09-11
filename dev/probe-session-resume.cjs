/*
 * 探针：SDK 协议下会话 id 的复用语义。
 *
 * 实测得到的行为（DSH 0.1.3 线）：
 *   1. 同一个运行时进程内，复用同一 sessionId = 接着同一上下文继续（多轮成立）。
 *   2. 进程重启后**不能**复用旧 sessionId —— 服务端只走 `agents.create`，
 *      而会话已被持久化到磁盘，create 会拒绝：
 *        [-32603] session "<id>" already exists
 *      （对应 packages/core/agent-loop/tests/resume.spec.ts 里那条
 *       `agents.create({sessionId}) rejects /already exists/`）
 *   3. 重启后换一个新的 sessionId 即可正常开始新会话。
 *
 * 对插件设计的影响：
 *   - sessionId 的生命周期必须绑定到「运行时进程实例」，进程一重启就换新 id。
 *   - 重载 Obsidian 后只能恢复「记录」用于阅读，上下文无法续接。
 *
 * 用法：node dev/probe-session-resume.cjs
 * 注意：会真实调用模型（三次极短对话），需要可用的 DSH 凭据。
 */
'use strict'

const path = require('path')
const Module = require('module')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js')
  return originalResolve.call(this, request, ...rest)
}

const { DshRuntime } = require(path.join(__dirname, '..', 'main.js'))

const CLI = process.env.DSH_CLI
  || path.join(process.env.USERPROFILE || process.env.HOME || '', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
const CWD = process.env.DSH_PROBE_CWD || process.cwd()
const STAMP = Date.now()
const SHARED_ID = `session-probe-shared${STAMP}`
const FRESH_ID = `session-probe-fresh${STAMP}`

/**
 * 建一个运行时。state.sessionId 在每次 turn() 前设置，
 * 通知处理器按它过滤，因此同一个运行时可以服务多个会话 id。
 */
function makeRuntime() {
  const state = { current: null, texts: [], sessionId: '' }
  const runtime = new DshRuntime({
    nodePath: process.env.DSH_NODE || 'node',
    cliPath: CLI,
    profile: 'sdk',
    cwd: CWD,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    onNotification: (method, params) => {
      if (!params || params.sessionId !== state.sessionId) return
      if (method === 'session.status') {
        if (params.status === 'running' && state.current) state.current.sawRunning = true
        if (params.status === 'idle') settle(state)
        return
      }
      if (method !== 'session.event') return
      const event = params.event || {}
      if (event.type === 'assistant/message') {
        const blocks = (event.data && event.data.message && event.data.message.content) || []
        const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
        if (text.trim()) state.texts.push(text)
      } else if (event.type === 'turn/end') {
        settle(state)
      }
    },
    onStderr: () => {},
  })
  return { runtime, state }
}

/** 本轮结束：必须先见到 running，再收到 turn/end 或 idle。 */
function settle(state) {
  const w = state.current
  if (w && w.sawRunning && !w.done) {
    w.done = true
    clearTimeout(w.timer)
    w.resolve()
  }
}

/** 发一轮并等结束，返回助手文本。 */
async function turn(runtime, state, sessionId, prompt) {
  state.sessionId = sessionId
  state.texts = []
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (state.current) state.current.done = true
      resolve()
    }, 180000)
    state.current = { resolve, timer, sawRunning: false, done: false }
  })
  await runtime.prompt(sessionId, prompt)
  await done
  state.current = null
  return state.texts.slice()
}

async function main() {
  console.log('CLI =', CLI)
  console.log('CWD =', CWD)
  console.log('')

  // ---- 进程 A：同一 id 跑两轮，验证进程内多轮成立 ----
  const a = makeRuntime()
  await a.runtime.start()
  const a1 = await turn(a.runtime, a.state, SHARED_ID, '请记住数字 7413。只回复两个字：好的')
  console.log('[A#1]', JSON.stringify(a1))
  const a2 = await turn(a.runtime, a.state, SHARED_ID, '我刚才让你记住的数字是多少？只回复那个数字')
  console.log('[A#2]', JSON.stringify(a2))
  const inProcessMultiTurn = /7413/.test(a2.join(' '))
  a.runtime.stop()
  await new Promise((r) => setTimeout(r, 2500))

  // ---- 进程 B：先复用旧 id（应被拒），再换新 id（应成功）----
  const b = makeRuntime()
  await b.runtime.start()

  let sharedOutcome = ''
  try {
    await turn(b.runtime, b.state, SHARED_ID, '只回复：好')
    sharedOutcome = 'unexpected-ok'
  } catch (error) {
    sharedOutcome = error && error.message ? error.message : String(error)
  }
  console.log('[B] 复用旧 id =', sharedOutcome)

  const freshTexts = await turn(b.runtime, b.state, FRESH_ID, '只回复两个字：可以')
  console.log('[B] 换新 id   =', JSON.stringify(freshTexts))
  b.runtime.stop()

  console.log('')
  console.log('PROBE RESULT:')
  console.log('  进程内多轮      =', inProcessMultiTurn ? 'YES' : 'NO')
  console.log('  跨进程复用旧 id =', /already exists/i.test(sharedOutcome) ? 'REJECTED (already exists)' : sharedOutcome)
  console.log('  跨进程换新 id   =', freshTexts.length > 0 ? 'OK' : 'FAILED')
  setTimeout(() => process.exit(0), 1500)
}

main().catch((error) => {
  console.error('PROBE ERROR:', error && error.message ? error.message : String(error))
  process.exit(1)
})
