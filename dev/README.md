# dev

开发/校验脚本。**这些不是插件的一部分**，Obsidian 不会加载它们。

`main.js` 在末尾额外导出了 `DshRuntime`、`DshView`、`explainError`、
`buildSelectionPayload`、`checkEnvironment`、`linkifyVaultPaths`，
就是为了让这些脚本能在 Obsidian 之外复用同一份代码（不影响 Obsidian 把
`module.exports` 当插件类加载）。

## 脚本

| 脚本 | 作用 | 是否联网/调用模型 |
|---|---|---|
| `test-logic.cjs` | 逻辑回归测试：i18n 完整性、错误翻译、选区上下文构造、本轮结束判定、渲染与记录分工、DSH 设置解析与模型路由、构建落后检测 | 否 |
| `probe-route.cjs` | 打印插件这次会用的模型路由，以及它来自插件设置、DSH 设置还是内置兜底 | 否 |
| `probe-session-resume.cjs` | 协议探针：实测 SDK 协议下 sessionId 的复用语义 | 是（三次极短对话） |
| `obsidian-stub.js` | `obsidian` 模块测试替身，通过 `Module._resolveFilename` 钩子注入 | 否 |

## 运行

```sh
# 逻辑测试，随时可跑
node dev/test-logic.cjs

# 看这次会用哪个模型（读 $DSH_HOME/settings.yaml）
node dev/probe-route.cjs

# 协议探针（会真实调用模型，需要可用的 DSH 凭据）
node dev/probe-session-resume.cjs
```

探针可用的环境变量：

| 变量 | 默认 |
|---|---|
| `DSH_CLI` | `~/deepseek-harness/apps/cli/lib/bin.js` |
| `DSH_NODE` | `node` |
| `DSH_PROBE_CWD` | 当前工作目录 |
| `DSH_HOME` | `~/.dsh`（`probe-route.cjs` 用它定位设置文档） |

## 探针测出的会话语义（重要）

1. **同一个运行时进程内**复用同一 `sessionId` → 接着同一上下文继续，多轮成立。
2. **进程重启后不能复用旧 `sessionId`** → 服务端只走 `agents.create`，而会话已持久化到磁盘，
   create 会拒绝：`[-32603] session "<id>" already exists`。
3. **重启后换新的 `sessionId`** → 正常开始新会话。

因此插件把 `sessionId` 的生命周期绑定到运行时进程实例：进程一换就换新 id。
这条约束也是「重载 Obsidian 后只能恢复对话记录、不能续接上下文」的原因。
