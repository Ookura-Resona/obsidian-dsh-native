/*
 * 查看插件这次会用什么模型路由（不联网、不调用模型）。
 *
 * 它按插件的优先级解析：插件设置 > DSH 设置文档 > 内置兜底，
 * 并打印各来源的实际取值，用来确认「跟随 DSH」是否生效。
 *
 * 用法：node dev/probe-route.cjs
 * 可用环境变量：
 *   DSH_HOME   指定 DSH 配置目录（默认 ~/.dsh）
 */
'use strict'

const path = require('path')
const os = require('os')
const Module = require('module')

const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js')
  return originalResolve.call(this, request, ...rest)
}

const { resolveRoute, readDshDefaultModel } = require(path.join(__dirname, '..', 'main.js'))

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

console.log('DSH_HOME =', dshHome)
console.log('')

const fromDsh = readDshDefaultModel(dshHome)
console.log('DSH 设置文档里的默认模型：')
if (fromDsh) {
  console.log('  provider =', fromDsh.provider)
  console.log('  model    =', fromDsh.model)
  console.log('  effort   =', fromDsh.reasoningEffort || '（未设置）')
} else {
  console.log('  （没读到，可能文件不存在或没有 agent-default-model 分节）')
}
console.log('')

console.log('插件设置留空时最终会用的路由（即真实运行时的取值）：')
const followDsh = resolveRoute({ provider: '', model: '', reasoningEffort: '' }, dshHome)
console.log('  provider =', followDsh.provider)
console.log('  model    =', followDsh.model)
console.log('  effort   =', followDsh.reasoningEffort || '（模型默认）')
console.log('  来源     =', followDsh.source)
console.log('')

console.log('插件设置填了 provider/model 时（覆盖）：')
const overridden = resolveRoute({ provider: 'example-provider', model: 'example-model' }, dshHome)
console.log('  provider =', overridden.provider)
console.log('  model    =', overridden.model)
console.log('  effort   =', overridden.reasoningEffort || '（模型默认）')
console.log('  来源     =', overridden.source)
