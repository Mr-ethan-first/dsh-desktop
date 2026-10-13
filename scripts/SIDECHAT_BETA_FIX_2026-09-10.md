# 「侧边对话(beta)」崩溃修复报告（2026-09-10）

## 一、现象

右侧栏选择 **侧边对话(beta)** 页签 → 报错：

```
dsh-better-sidebar: Cannot read properties of undefined (reading 'getSnapshot')
```

## 二、根因：插件版本与宿主版本错位（不是同一条路径，也不是上次那两个问题）

`dsh-better-sidebar@0.18.1` 自述 **仅支持 DSH 0.1.2-rc.1+**（`AGENTS.md`：peer 下限 `^0.1.2-rc.1`，CI 钉 rc.1）；
而本机部署的 `dsh-runtime` 是 **0.1.2-alpha.1**（`@deepseek-ai/dsh-base|dsh-web-app|dsh-client-*` 全为 alpha.1）。
侧边对话用到的两个 API 是 **后加的**：

| 插件用法 | 引入版本 | alpha.1 的真实形态 | 后果 |
|---|---|---|---|
| `ctx.connection.state.getSnapshot()/subscribe()` | 0.1.2-**alpha.2** | `connection` 服务**存在**，但 handle 只有 `isLoopback / generation / rpc / registerGenerationSource / start` | `ctx.connection` 非空 → `?.` 不短路 → `.state` 为 `undefined` → `undefined.getSnapshot()` → **本次报错** |
| `Session.snapshotEvents()` | 0.1.2-**alpha.4** | 只有 `get events()` 属性 | 宿主侧 `session.snapshotEvents is not a function` |

**决定性证据**（读部署态运行时源码，非推测）：

```js
// dsh-client-connection/lib/client.js —— ctx.provide("connection", handle)
const handle = { isLoopback, generation: { getSnapshot, subscribe }, rpc, registerGenerationSource, start }
//                                                          ↑ 没有 state，也没有 reconnect
```

```js
// dsh-session/lib/index.js:1465 —— alpha.1 的替代面
get events() { this.eventsSnapshot ??= Object.freeze([...this.log]); return this.eventsSnapshot; }
// 追加时 this.eventsSnapshot = void 0 —— 与 snapshotEvents() 同为「追加即失效的不可变快照」
```

> 关键教训：`ctx.connection?.state.getSnapshot()` 里的 `?.` **只保护 `ctx.connection` 本身**。服务在、`state` 不在时，
> 整条链不会短路，直接对 `undefined` 取属性。这是本次崩溃的全部原因。

**排除串线**：本问题与上一轮修的两个问题**无关** ——
① 内置浏览器 iframe 沙箱（`dsh-better-sidebar/lib/client*.js` 的 `iframeSandboxFor`）、
② Electron `setWindowOpenHandler`。那是「侧边栏内置浏览器」，这次是「侧边对话」页签，属插件里另一块代码。

## 三、修复

### 源码（`packages/extensions/DSH-better-sidebar-0.18.1/`）

| 文件 | 改动 |
|---|---|
| `src/session-log.ts` | **新增**：跨代读取会话日志的 `sessionLogEvents()` —— 有 `snapshotEvents()` 用方法，否则回退 `session.events`；对象缺失/方法抛错返回 `undefined` |
| `src/index.ts` | `ctx.sessions.get(id)?.snapshotEvents()` → `sessionLogEvents(...)`（保留 `undefined` 语义，persistence 回退照旧） |
| `src/jobs-routes.ts` | 同上（`?? []`） |
| `src/sidechat-routes.ts` | 4 处：`threadLogEvents` / `buildSidechatInheritance` / `resolvePresetId` / `boundaryDelivered` |
| `src/subagent-live-route.ts` | 同上 |
| `src/context-types.ts` | `snapshotEvents` 改为可选、新增可选 `events`；`connection.state`/`reconnect` 改为可选并写明「alpha.1 有服务无此面」 |
| `src/client/SideChatView.tsx` | **崩溃点**：`const connectionRecovery = ctx.connection?.state` 后做特性检测；`reconnect` 改可选调用 |

### 部署态（运行中的 GUI 加载的是这些构建产物，不是 TS 源码）

补丁脚本 `scripts/_patch_sidebar_alpha1_compat.mjs`（逐条**精确计数断言**，改错就报错退出；写前自动备份 `.bak-alpha1-<ts>`）：

| 文件 | 改动 | 字节变化 |
|---|---|---|
| `lib/index.js` | 注入 `sessionLogEvents` 垫片 + 7 处调用点改写 | 191,051 → 191,722 |
| `lib/client.js` | `connectionRecovery` 特性检测 + `reconnect?.()` | 923,086 → 923,167 |
| `lib/client-registry.js` | 同上（同一函数两份，必须一起改） | 923,290 → 923,371 |

## 四、验证

**回归脚本 `scripts/_verify_sidebar_alpha1_compat.mjs` —— 从已打补丁的部署产物里抽出真实代码，喂 alpha.1 形状的假对象：19/19 通过。**

- 旧表达式**精确复现**用户报错：`TypeError: Cannot read properties of undefined (reading 'getSnapshot')` ✔
- 新表达式在 alpha.1 下降级为 `undefined`（不抛错），在 alpha.2+ 形状上仍能读到 `'disconnected'` ✔
- 垫片读 alpha.1 的 `events` 属性；追加事件后能看到新事件；优先用新版方法；对象缺失 / 方法抛错 → `undefined` ✔
- 三个 bundle `node --check` 全部通过 ✔
- `tsc --noEmit`：`session-log.ts` **0 错误**；其余改动文件无新增类型错误（现存报错均为无 `node_modules` 导致的环境噪声）✔
- 依赖面核对：`sessionPersistence / agentPresets / sessionTitle / agents / subagents` 五个服务在 alpha.1 都在；`snapshotSubagentDescriptor`、`createUserMessage` 均在 ✔

## 五、遗留与注意

1. **需要重启 DeepSeekAgent**（客户端 bundle 在启动时加载）后再试侧边对话。
2. 本次只保证「页签不再崩」+「会话日志读取可用」。侧边对话的**建线程/续聊**还依赖
   `agents.create/resume` 的选项形状等语义差异（alpha.1 vs rc.1），静态无法完全证实——**需一次真机点测**。
3. **NSIS 安装包未重打**（只更新了运行态 `D:\DeepSeekAgent`）；插件升级会覆盖部署态改动（源码已同步，重跑补丁脚本即可）。
4. 同类「插件用了比 alpha.1 更新的 API」风险仍在别处存在，排查手法：读部署态 runtime 的 `provide(...)` 面 vs 插件调用点。
