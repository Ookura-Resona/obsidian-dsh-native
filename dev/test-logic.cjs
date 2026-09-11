/*
 * 纯逻辑回归测试（不联网、不调用模型）。
 *
 * 覆盖：
 *   - main.js 能被加载（捕获语法/require 错误）
 *   - explainError 把各类原始错误映射成「人话 + 动作」
 *   - buildSelectionPayload 的三种模式
 *   - DshView.reportTurnEnd 对 TurnEndReason 的处理
 *
 * 用法：node dev/test-logic.cjs
 */
'use strict'

const path = require('path')
const assert = require('assert')
const Module = require('module')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js')
  return originalResolve.call(this, request, ...rest)
}

// appendNotice / scrollToBottom 依赖浏览器环境
global.window = { requestAnimationFrame: (fn) => fn() }

let passed = 0
let failed = 0

/** 极简测试运行器。 */
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : String(error)}`)
  }
}

console.log('加载 main.js…')
const main = require(path.join(__dirname, '..', 'main.js'))
const { DshView, explainError, buildSelectionPayload } = main

console.log('')
console.log('explainError')
test('ENOENT -> node 路径问题，并给出设置类动作', () => {
  const info = explainError(new Error('spawn C:\\nope\\node.exe ENOENT'))
  assert.strictEqual(info.title, '找不到 node 可执行文件')
  assert.ok(info.actions.includes('settings'))
  assert.ok(info.actions.includes('check'))
  assert.ok(info.hints.length > 0)
})

test('会话 id 冲突 -> 提示换新会话，而不是当成未知错误', () => {
  const info = explainError(new Error('[-32603] session "session-abc" already exists'))
  assert.strictEqual(info.title, '会话 id 已被占用')
  assert.ok(info.actions.includes('newSession'))
})

test('缺 bin.js -> 提示去构建', () => {
  const info = explainError(new Error('未找到 dsh CLI 产物。请在插件设置里填写 bin.js 的绝对路径。'))
  assert.strictEqual(info.title, '没找到 dsh 的构建产物（bin.js）')
})

test('provider 未注册 -> 指向设置页', () => {
  const info = explainError(new Error('no adapter registered for provider "foo"'))
  assert.strictEqual(info.title, 'provider 名称不被识别')
  assert.deepStrictEqual(info.actions, ['settings'])
})

test('initialize 超时 -> 提示首次自举较慢', () => {
  const info = explainError(new Error('initialize 超时（180000ms）'))
  assert.strictEqual(info.title, 'initialize 握手超时')
})

test('运行时退出 -> 提供重启动作', () => {
  const info = explainError(new Error('dsh 运行时已退出（code=1, signal=null）'))
  assert.strictEqual(info.title, 'dsh 运行时进程退出了')
  assert.ok(info.actions.includes('restart'))
})

test('凭据问题被识别', () => {
  const info = explainError(new Error('401 Unauthorized: invalid api key'))
  assert.strictEqual(info.title, '凭据相关问题')
})

test('未知错误也有兜底卡片与动作', () => {
  const info = explainError(new Error('something odd happened'))
  assert.strictEqual(info.title, '出错了')
  assert.ok(info.actions.length > 0)
  assert.ok(info.detail.includes('something odd'))
})

console.log('')
console.log('buildSelectionPayload')

/** 造一个只实现所需方法的编辑器替身。 */
function fakeEditor(text) {
  return {
    getSelection: () => text,
    getCursor: (which) => (which === 'from' ? { line: 11, ch: 2 } : { line: 14, ch: 7 }),
  }
}

const FILE = { path: '灵茶山艾府/位运算.md' }
const TEXT = '这是一段被选中的原文'

test('text 模式：只发原文', () => {
  const out = buildSelectionPayload(fakeEditor(TEXT), FILE, 'text')
  assert.strictEqual(out, TEXT)
})

test('reference 模式：含文件与行:列，但不含原文', () => {
  const out = buildSelectionPayload(fakeEditor(TEXT), FILE, 'reference')
  assert.ok(out.includes(FILE.path), '应包含文件路径')
  assert.ok(out.includes('第 12 行第 3 列'), `应包含起始行列，实际：${out}`)
  assert.ok(out.includes('第 15 行第 8 列'), '应包含结束行列')
  assert.ok(out.includes(`${TEXT.length} 字符`), '应包含字数')
  assert.ok(!out.includes(TEXT), 'reference 模式不应包含原文')
})

test('both 模式：引用 + 原文都在', () => {
  const out = buildSelectionPayload(fakeEditor(TEXT), FILE, 'both')
  assert.ok(out.includes(FILE.path))
  assert.ok(out.includes(TEXT))
})

test('没有活动文件时退化为原文', () => {
  const out = buildSelectionPayload(fakeEditor(TEXT), null, 'reference')
  assert.strictEqual(out, TEXT)
})

test('空选区返回空串', () => {
  assert.strictEqual(buildSelectionPayload(fakeEditor('   '), FILE, 'reference'), '')
})

console.log('')
console.log('reportTurnEnd（TurnEndReason 是带 kind 的对象）')

function makeView() {
  const notices = []
  // 面板会通过 plugin.queueTranscriptSave 持久化记录，测试替身补上这个方法
  const view = new DshView({}, { settings: { showToolActivity: true }, queueTranscriptSave: () => {} })
  view.messagesEl = {
    createDiv: () => ({ setText: (text) => notices.push(text) }),
  }
  return { view, notices }
}

test('completed 保持静默（早期实现会误报）', () => {
  const { view, notices } = makeView()
  view.reportTurnEnd({ kind: 'completed' })
  assert.strictEqual(notices.length, 0, JSON.stringify(notices))
})

test('max-tokens 给出可读提示', () => {
  const { view, notices } = makeView()
  view.reportTurnEnd({ kind: 'max-tokens' })
  assert.strictEqual(notices.length, 1)
  assert.ok(notices[0].includes('输出上限'), notices[0])
})

test('error 带出错误信息', () => {
  const { view, notices } = makeView()
  view.reportTurnEnd({ kind: 'error', error: { message: 'boom' } })
  assert.ok(notices[0].includes('boom'), notices[0])
})

test('aborted 带出原因', () => {
  const { view, notices } = makeView()
  view.reportTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })
  assert.ok(notices[0].includes('aborted') && notices[0].includes('user'), notices[0])
})

test('缺省与异常输入不抛错', () => {
  const { view, notices } = makeView()
  view.reportTurnEnd(undefined)
  view.reportTurnEnd({})
  assert.strictEqual(notices.length, 0)
})

console.log('')
console.log('渲染与记录的分工（防双重渲染回归）')

/** 造一个会统计建了几个 DOM 节点的面板。 */
function makeCountingView() {
  const created = []
  const view = new DshView({}, { settings: { showToolActivity: true }, queueTranscriptSave: () => {} })
  view.messagesEl = {
    createDiv: (options) => {
      const node = {
        cls: options && options.cls,
        text: '',
        setText(value) { this.text = value },
        querySelector: () => null,
      }
      created.push(node)
      return node
    },
    querySelector: () => null,
  }
  return { view, created }
}

test('pushEntry 只渲染一次', () => {
  const { view, created } = makeCountingView()
  view.pushEntry({ role: 'notice', text: 'x' })
  assert.strictEqual(created.length, 1, `应只创建 1 个节点，实际 ${created.length}（双重渲染回归）`)
  assert.strictEqual(view.transcript.length, 1)
})

test('pushEntry 记用户消息也只渲染一次', () => {
  const { view, created } = makeCountingView()
  view.pushEntry({ role: 'user', text: 'hello' })
  assert.strictEqual(created.length, 1, `应只创建 1 个节点，实际 ${created.length}`)
})

test('renderEntry 只画不记录（恢复历史不会重复入数组）', () => {
  const { view, created } = makeCountingView()
  view.renderEntry({ role: 'assistant', text: 'y' })
  assert.strictEqual(created.length, 1)
  assert.strictEqual(view.transcript.length, 0, '不应写入 transcript')
})

test('工具行按 error 标记走不同样式类', () => {
  const { view, created } = makeCountingView()
  view.pushEntry({ role: 'tool', text: 'ok' })
  view.pushEntry({ role: 'tool', text: 'bad', error: true })
  assert.strictEqual(created[0].cls, 'dsh-tool')
  assert.strictEqual(created[1].cls, 'dsh-tool is-error')
})

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
