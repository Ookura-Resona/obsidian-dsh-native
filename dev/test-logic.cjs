/*
 * 纯逻辑回归测试（不联网、不调用模型）。
 *
 * 覆盖：
 *   - main.js 能被加载（捕获语法/require 错误）
 *   - i18n：中英词典 key 完全对齐、源码里用到的每个 key 都存在
 *   - explainError 把各类原始错误映射成「人话 + 动作」（中英两种语言）
 *   - buildSelectionPayload 的三种模式
 *   - DshView.reportTurnEnd 对 TurnEndReason 的处理
 *   - 渲染与记录的分工（防双重渲染回归）
 *
 * 用法：node dev/test-logic.cjs
 */
'use strict'

const fs = require('fs')
const os = require('os')
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

const MAIN_PATH = path.join(__dirname, '..', 'main.js')
const MAIN_SOURCE = fs.readFileSync(MAIN_PATH, 'utf8')

console.log('加载 main.js…')
const main = require(MAIN_PATH)
const {
  DshView, explainError, buildSelectionPayload, buildSelectionReference, setLanguage, DICT, ERR,
  resolveRoute, readDshDefaultModel, parseYamlSections, checkBuildFreshness, FALLBACK_ROUTE,
} = main

// 逻辑断言默认按中文，英文另有专门用例
setLanguage('zh')

console.log('')
console.log('i18n')

test('zh 与 en 的 key 集合完全一致', () => {
  const zh = Object.keys(DICT.zh).sort()
  const en = Object.keys(DICT.en).sort()
  const onlyZh = zh.filter((k) => !(k in DICT.en))
  const onlyEn = en.filter((k) => !(k in DICT.zh))
  assert.deepStrictEqual(
    { onlyZh, onlyEn },
    { onlyZh: [], onlyEn: [] },
    `词典不对称 —— 仅 zh: ${onlyZh.join(', ')}；仅 en: ${onlyEn.join(', ')}`,
  )
  assert.ok(zh.length > 100, `词条太少，可能没扫全：${zh.length}`)
})

test('源码里用到的每个 t() key 在两份词典里都存在', () => {
  const used = new Set()
  for (const match of MAIN_SOURCE.matchAll(/\bt\('([^']+)'/g)) used.add(match[1])
  assert.ok(used.size > 100, `扫描到的 key 太少，正则可能失配：${used.size}`)
  const missing = []
  for (const key of used) {
    if (!(key in DICT.zh)) missing.push(`zh:${key}`)
    if (!(key in DICT.en)) missing.push(`en:${key}`)
  }
  assert.deepStrictEqual(missing, [], `缺少文案：${missing.join(', ')}`)
})

test('两份词典里没有未被使用的死词条', () => {
  const used = new Set()
  for (const match of MAIN_SOURCE.matchAll(/\bt\('([^']+)'/g)) used.add(match[1])
  const unused = Object.keys(DICT.zh).filter((key) => !used.has(key))
  assert.deepStrictEqual(unused, [], `未被引用的词条：${unused.join(', ')}`)
})

test('占位符 {name} 在两份词典里一一对应', () => {
  const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const mismatched = []
  for (const key of Object.keys(DICT.zh)) {
    const zh = holders(DICT.zh[key])
    const en = holders(DICT.en[key])
    if (zh.join(',') !== en.join(',')) mismatched.push(`${key}: zh=[${zh}] en=[${en}]`)
  }
  assert.deepStrictEqual(mismatched, [], `占位符不一致：\n       ${mismatched.join('\n       ')}`)
})

test('语言切换生效，且未翻译的 key 回退为 key 本身', () => {
  setLanguage('en')
  assert.strictEqual(main.getLanguage(), 'en')
  setLanguage('zh')
  assert.strictEqual(main.getLanguage(), 'zh')
  setLanguage('zh-CN')
  assert.strictEqual(main.getLanguage(), 'zh', 'zh-CN 应归一为 zh')
  setLanguage('fr')
  assert.strictEqual(main.getLanguage(), 'en', '非中文应回退为 en')
  setLanguage('zh')
})

console.log('')
console.log('explainError（中文）')

test('ENOENT -> node 路径问题，并给出设置类动作', () => {
  const info = explainError(new Error('spawn C:\\nope\\node.exe ENOENT'))
  assert.strictEqual(info.title, '找不到 node 可执行文件')
  assert.ok(info.actions.includes('settings'))
  assert.ok(info.actions.includes('check'))
  assert.ok(info.hints.length > 0)
})

test('spawn 失败 code 也能命中 node 分支（不依赖英文文案）', () => {
  const error = new Error('随便什么消息')
  error.code = ERR.spawnFailed
  assert.strictEqual(explainError(error).title, '找不到 node 可执行文件')
})

test('会话 id 冲突 -> 提示换新会话，而不是当成未知错误', () => {
  const info = explainError(new Error('[-32603] session "session-abc" already exists'))
  assert.strictEqual(info.title, '会话 id 已被占用')
  assert.ok(info.actions.includes('newSession'))
})

test('缺 bin.js（带 code）-> 提示去构建', () => {
  const error = new Error('不管什么语言的消息')
  error.code = ERR.noCli
  assert.strictEqual(explainError(error).title, '没找到 dsh 的构建产物（bin.js）')
})

test('provider 未注册 -> 指向设置页', () => {
  const info = explainError(new Error('no adapter registered for provider "foo"'))
  assert.strictEqual(info.title, 'provider 名称不被识别')
  assert.deepStrictEqual(info.actions, ['settings'])
})

test('超时（带 code）-> 提示首次自举较慢', () => {
  const error = new Error('whatever')
  error.code = ERR.timeout
  assert.strictEqual(explainError(error).title, 'initialize 握手超时')
})

test('运行时退出（带 code）-> 提供重启动作', () => {
  const error = new Error('whatever')
  error.code = ERR.exited
  const info = explainError(error)
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
console.log('explainError / 选区（English）')

test('英文下错误卡片是英文', () => {
  setLanguage('en')
  try {
    const info = explainError(new Error('spawn node ENOENT'))
    assert.strictEqual(info.title, 'node executable not found')
    assert.ok(info.hints[0].includes('Set "node executable"'), info.hints[0])
    const error = new Error('x')
    error.code = ERR.noCli
    assert.strictEqual(explainError(error).title, 'dsh build artifact (bin.js) not found')
  } finally {
    setLanguage('zh')
  }
})

test('英文选区引用是英文措辞', () => {
  setLanguage('en')
  try {
    const ref = buildSelectionReference('notes/a.md', { line: 11, ch: 2 }, { line: 14, ch: 7 }, 87)
    assert.ok(ref.includes('selected passage'), ref)
    assert.ok(ref.includes('line 12 col 3'), ref)
    assert.ok(ref.includes('87 chars'), ref)
  } finally {
    setLanguage('zh')
  }
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
  assert.strictEqual(buildSelectionPayload(fakeEditor(TEXT), FILE, 'text'), TEXT)
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
  assert.strictEqual(buildSelectionPayload(fakeEditor(TEXT), null, 'reference'), TEXT)
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
console.log('跟随 DSH 的模型设置')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-test-'))

/** 造一个 DSH 配置目录；content 以 { 开头就写成 settings.json。 */
function makeHome(name, content) {
  const dir = path.join(tmpRoot, name)
  fs.mkdirSync(dir, { recursive: true })
  if (content !== null) {
    const file = content.trimStart().startsWith('{') ? 'settings.json' : 'settings.yaml'
    fs.writeFileSync(path.join(dir, file), content, 'utf8')
  }
  return dir
}

const REAL_SETTINGS = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'ui-theme:',
  '  preference: system',
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-v4-flash-vision-exp',
  '  reasoningEffort: high',
  '',
].join('\n')

test('能解析真实形状的 settings.yaml', () => {
  const sections = parseYamlSections(REAL_SETTINGS)
  assert.deepStrictEqual(sections['agent-default-model'], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: 'high',
  })
  assert.strictEqual(sections['ui-theme'].preference, 'system')
})

test('容忍引号、行尾注释与空行', () => {
  const text = [
    '# 顶层注释',
    'agent-default-model:',
    '  provider: "deepseek-official"   # 带注释',
    "  model: 'deepseek-v4-flash'",
    '',
    'ui-theme:',
    '  preference: system',
  ].join('\n')
  const sections = parseYamlSections(text)
  assert.strictEqual(sections['agent-default-model'].provider, 'deepseek-official')
  assert.strictEqual(sections['agent-default-model'].model, 'deepseek-v4-flash')
  assert.strictEqual(sections['agent-default-model'].reasoningEffort, undefined)
})

test('支持流式写法 section: {a: 1, b: 2}', () => {
  const sections = parseYamlSections('agent-default-model: {provider: p, model: m}\n')
  assert.strictEqual(sections['agent-default-model'].provider, 'p')
  assert.strictEqual(sections['agent-default-model'].model, 'm')
})

test('哈希值里的 # 不会被当成注释（值内含引号）', () => {
  const sections = parseYamlSections('agent-default-model:\n  provider: "p#1"\n  model: m\n')
  assert.strictEqual(sections['agent-default-model'].provider, 'p#1')
})

test('缺少分节 / 字段不全 / 目录不存在 -> 返回 null 交给调用方回退', () => {
  assert.strictEqual(readDshDefaultModel(makeHome('no-section', 'ui-theme:\n  preference: system\n')), null)
  assert.strictEqual(readDshDefaultModel(makeHome('half', 'agent-default-model:\n  provider: p\n')), null)
  assert.strictEqual(readDshDefaultModel(path.join(tmpRoot, 'not-here')), null)
})

test('也能读 settings.json', () => {
  const home = makeHome('json-home', JSON.stringify({ 'agent-default-model': { provider: 'p', model: 'm' } }))
  assert.deepStrictEqual(readDshDefaultModel(home), { provider: 'p', model: 'm', reasoningEffort: '' })
})

const REAL_HOME = makeHome('real-home', REAL_SETTINGS)

test('插件没填 -> 跟随 DSH 设置', () => {
  const route = resolveRoute({ provider: '', model: '', reasoningEffort: '' }, REAL_HOME)
  assert.strictEqual(route.provider, 'deepseek-official')
  assert.strictEqual(route.model, 'deepseek-v4-flash-vision-exp')
  assert.strictEqual(route.reasoningEffort, 'high')
  assert.strictEqual(route.source, 'dsh')
  assert.strictEqual(route.partialOverride, false)
})

test('插件填全了 -> 用插件的，未覆盖的 effort 仍跟随 DSH', () => {
  const route = resolveRoute({ provider: 'acme', model: 'acme-large', reasoningEffort: '' }, REAL_HOME)
  assert.strictEqual(route.provider, 'acme')
  assert.strictEqual(route.model, 'acme-large')
  assert.strictEqual(route.source, 'plugin')
  assert.strictEqual(route.reasoningEffort, 'high', '未覆盖的 effort 应继续跟随 DSH')
})

test('只填一个 -> 不算覆盖，仍跟随 DSH 并标记出来', () => {
  const route = resolveRoute({ provider: 'acme', model: '', reasoningEffort: '' }, REAL_HOME)
  assert.strictEqual(route.provider, 'deepseek-official')
  assert.strictEqual(route.source, 'dsh')
  assert.strictEqual(route.partialOverride, true)
})

test('两边都没有 -> 用内置兜底并标记来源', () => {
  const route = resolveRoute({ provider: '', model: '' }, path.join(tmpRoot, 'nothing-here'))
  assert.strictEqual(route.source, 'fallback')
  assert.strictEqual(route.provider, FALLBACK_ROUTE.provider)
  assert.strictEqual(route.model, FALLBACK_ROUTE.model)
})

test('DSH 换了默认模型，解析结果跟着变（这就是「跟随」）', () => {
  const home = makeHome('changed-home', 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v5-whatever\n')
  const route = resolveRoute({ provider: '', model: '' }, home)
  assert.strictEqual(route.model, 'deepseek-v5-whatever')
})

console.log('')
console.log('构建产物落后检测')

test('产物比源码新 -> 不落后；源码更新后 -> 落后', () => {
  const repo = path.join(tmpRoot, 'fake-repo')
  const srcDir = path.join(repo, 'apps', 'cli', 'src')
  const libDir = path.join(repo, 'apps', 'cli', 'lib')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.mkdirSync(libDir, { recursive: true })
  const binPath = path.join(libDir, 'bin.js')
  fs.writeFileSync(binPath, '// built')
  const sourceFile = path.join(srcDir, 'a.ts')
  fs.writeFileSync(sourceFile, '// src')

  const builtAt = new Date(Date.now() + 60000)
  fs.utimesSync(binPath, builtAt, builtAt)
  fs.utimesSync(sourceFile, new Date(), new Date())
  assert.strictEqual(checkBuildFreshness(binPath).stale, false)

  const later = new Date(Date.now() + 120000)
  fs.utimesSync(sourceFile, later, later)
  const result = checkBuildFreshness(binPath)
  assert.strictEqual(result.applicable, true)
  assert.strictEqual(result.stale, true)
})

test('不是检出布局 -> 判定为不适用', () => {
  const lonely = path.join(tmpRoot, 'lonely')
  fs.mkdirSync(lonely, { recursive: true })
  const binPath = path.join(lonely, 'bin.js')
  fs.writeFileSync(binPath, 'x')
  const result = checkBuildFreshness(binPath)
  assert.strictEqual(result.applicable, false)
  assert.strictEqual(result.stale, false)
})

console.log('')
console.log(`结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
