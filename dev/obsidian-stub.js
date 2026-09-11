/*
 * `obsidian` 模块测试替身。
 *
 * 用途：让 `main.js` 能在 Obsidian 之外被 require，从而对纯逻辑（协议分帧、
 * 错误翻译、选区上下文构造、本轮结束判定等）跑自动化测试。
 *
 * 只实现被 require 到的导出；不模拟任何 Obsidian 行为。
 * 通过 Module._resolveFilename 钩子注入（见 dev/*.cjs），因此不需要 node_modules。
 */
'use strict'

class Plugin {}
class ItemView {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class MarkdownRenderer {}
class MarkdownView {}

module.exports = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownRenderer,
  MarkdownView,
}
