# DeepSeekAgent 详细设计说明书

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0 | 2026-09-04 | 首版。对应交付物 `DeepSeekAgent-Setup-0.1.0.exe`；与《架构设计说明书》v1.0 同源 |

---

## 1. 代码结构

```
apps/agent-client/
├── electron/                      # Electron 主进程域（asarUnpack，始终落地为真实文件）
│   ├── main.cjs                   # 主进程入口：HTTP 服务、窗口、IPC、进程编排、退出清场（~1900 行，按区块注释分段）
│   ├── preload.cjs                # contextBridge：向渲染进程暴露受控 IPC API（electronAPI）
│   ├── plugin-host/               # 插件宿主与 dsh web 拉起
│   │   ├── dsh-web-launcher.cjs   # dsh web 子进程 launcher（可被 vitest 单测，零 electron 依赖）
│   │   ├── api-proxy.cjs          # 静态工作台 → 主后端的 API 反向代理
│   │   ├── scan-extensions.cjs    # 扫描 packages/extensions 的插件清单
│   │   ├── index.js / registry.js / manifest.js
│   │   └── cordis-host/           # 插件的 Cordis 宿主桥接
│   └── harness/                   # 本地 Harness 后端（TypeScript 源码）
│       ├── app.ts                 # HarnessApp：服务组装（cordis ctx.plugin 顺序挂载）+ setApiKey/setWorkspace
│       ├── config.ts              # loadHarnessConfig：环境变量→强类型配置（验证失败即抛）
│       ├── llm.ts                 # LlmRuntime + DeepSeekAdapter（流式、限流闸门、重试、usage 统计）
│       ├── agent-loop.ts          # AgentLoop / AgentRegistry（含 modlens 配置）
│       ├── session.ts             # SessionStore（事件溯源会话）
│       ├── session-persistence.ts # sql.js SQLite → 文件持久化兜底
│       ├── tools/ + tools.ts      # fs 工具等（权限等级 read/write/execute）
│       ├── mcp.ts / skill.ts      # MCP 运行时、技能运行时
│       ├── ipc-bridge.ts          # HarnessIpcBridge：harness 事件 → 渲染进程
│       ├── context.ts             # 轻量 cordis 风格 Context
│       └── harness-dist/          # 上述源码的编译产物（tsc -p，随包分发）
├── src/                           # 兜底 React SPA（仅在工作台不可用时作为主窗口内容）
│   ├── App.tsx + screens/         # Providers / HarnessChat / Plugins / Settings / McpPanel / SkillsPanel …
│   ├── adapter/                   # OpenAI 兼容客户端（zhipu.ts 历史命名=适配器本体）、provider-config.ts
│   └── orchestration/             # 工作模式（ask/plan/craft）、思考过程展示
├── dist/                          # SPA vite 构建产物（进 app.asar）
├── scripts/
│   ├── pack-app-asar.mjs          # asar 外科手术打包 + 部署（--deploy D:\DeepSeekAgent）
│   ├── verify-default-models.mjs  # 交付门控：校验 dsh-runtime 默认 provider/模型/无 Key
│   └── automated-test-exe.mjs 等  # 生命周期/布局自动化验证
├── installer/
│   ├── DeepSeekAgent.nsi          # NSIS 安装/卸载脚本（注释必须纯 ASCII）
│   └── DeepSeekAgent.cmd          # 随包分发的无 Node 依赖启动器
└── config/                        # provider.json.example / mcp-servers.json.example（结构示例，不被自动加载）

desktop/                           # 打包输入（electron-builder extraResources）
├── runtime-dist/                  # dsh 运行时闭包（pnpm deploy 产物，387MB，随包 → resources/dsh-runtime）
├── runtime-closure/               # runtime-dist 的源头（package.json 依赖清单）
└── launcher/                      # 开发态启动器（run-agent.js）
```

仓库其余部分（`packages/`、`vendor/`、`python/` 等）为 deepseek-harness 主工程，客户端**只读消费**。

## 2. 主进程模块设计（main.cjs 区块）

### 2.1 启动环境剥离（模块级，最先执行）

```
if (DSH_TRUST_LAUNCH_ENV !== '1'):
  delete process.env[DEEPSEEK_API_KEY(S), DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,
                     DSH_API_KEY, DSH_BASE_URL, DSH_MODEL,
                     ZHIPU_API_KEY(S), ZHIPU_API_BASE, ZHIPU_PRIMARY_MODEL, ZHIPU_MODEL,
                     DASHSCOPE_API_KEY(S), ALIYUN_API_KEYS, GLMMODEL_API_KEY]
```

位置在所有 `loadEnvFile` 之前，保证 `.env`（用户显式配置）仍能生效。

### 2.2 稳定性区块（app.whenReady 之前）

- `disableHardwareAcceleration()` + commandLine 开关（disable-gpu / gpu-sandbox / gpu-watchdog / Vulkan / 硬件视频解码；**不禁用软件光栅化**——曾致窗口重绘 FATAL abort）
- `js-flags --max-old-space-size=8192`（`DSH_MAIN_HEAP_MB` 可覆盖）
- 可选开关：`DSH_REMOTE_DEBUGGING_PORT`（远程调试）、`DSH_USER_DATA_DIR`（E2E 隔离 userData）、`DSH_HEADLESS=1`（无窗口）、`DSH_OFFSCREEN=1`（离屏渲染复现）
- 诊断日志目录 `os.tmpdir()/dsh-agent-logs/`：`electron-<date>.log`（Chromium 详细日志，默认级别）、`startup-*.log`、`crash-*.log`（统一落盘函数 `logCrash(kind, detail)`，JSON 单行）、`agent-*.log`（渲染进程转发）、`oom-snapshot-*.log`、`mem-*.log`
- IPC 洪水检测：包装 `ipcMain.handle`，单通道 ≥40 次/秒记 `ipc-flood` 日志（不阻断）
- OOM 濒死取证：堆高水位 1400MB 触发快照（2s 冷却），记录 topIpc 直方图

### 2.3 HTTP 主后端（:5183）

| 路由 | 行为 |
|---|---|
| `/healthz` | 就绪状态 + harness/MCP 诊断（仅 `DSH_HEADLESS=1` 或 `DSH_TEST=1` 启用） |
| `/test/mcp/call` | 无头自动化 MCP 回传验证（同上） |
| `/zhipu/*` | OpenAI 兼容代理：剥离 `/api/paas/v4` 前缀 → `https://api.deepseek.com`，注入 `Authorization: Bearer <getKeys()[0]>`；SSE 流式透传；上游 20s 连接超时（防 EMFILE）；客户端断开即中止上游 |
| 其余 | `serveStatic(dist)`：SPA 静态资源 + 导航请求回退 index.html（静态资源缺失必须真 404，防 MIME 白屏） |

Key 池 `getKeys()`：`runtimeApiKey`（UI 下发）> `DEEPSEEK_API_KEYS > DEEPSEEK_API_KEY > DSH_API_KEY > ZHIPU_API_KEYS > ZHIPU_API_KEY`（全部来自剥离后环境，即仅 `.env` 显式配置）。**无任何内置 Key**；未配置时不注入 Authorization，由上游 401、前端提示填 Key。

### 2.4 dsh web 工作台编排

- `resolveDshBin()`：优先 `<resources>/dsh-runtime/node_modules/@deepseek-ai/dsh`（打包态）→ 仓库 `apps/cli`（开发态，lib/bin.js 或 src/bin.ts + tsx）
- `resolveBundledNode()`：`DSH_BUNDLED_NODE`（排障覆盖）> Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）> 系统 node
- `spawnDshWeb()`（dsh-web-launcher.cjs）：默认参数 `['web','--port',N,'--no-open']`；`prepareDshHome()` 幂等重建 `$DSH_HOME/profiles/web/package.json`（bundles = dsh-base + dsh-web-app + 社区插件）并修复 junction；env = 剥离后环境 + DSH_HOME，**删除 NODE_OPTIONS**
- 就绪判定：子进程 stdout 匹配 `http://127.0.0.1:<port>/?token=<id>` → `captureDshWebToken`：记录 `workbenchAuthUrl`，若主窗口存在且 cookie 未消费则立即 `loadURL(token)`（303 → HttpOnly SameSite=Strict cookie，默认 session 共享）
- 失败链：子进程就绪前退出或 45s 超时 → `killChildTree` → 换端口重试（≤20）→ 静态回退 `apps/web/dist`（非静态请求反代主后端，`DSH_WEB_PROXY_API=1` 默认开启）
- 竞态门：`servicesShutdown` 置位后禁止再 spawn；spawn 与 shutdown 竞态时立即回收

### 2.5 退出序列

```
用户点 X / app.quit()
  └─ win.on('close')：__allowClose=false → preventDefault + app.quit()（防渲染崩溃误判退出）
       └─ before-quit：
            isQuiting=true
            shutdownAllServices()          ← 一次性（servicesShutdown 门）
              ├─ killDshWebChild()          taskkill /PID <pid> /T /F（win32）；POSIX SIGKILL
              ├─ webServer.close()；server.close()
              └─ harnessApp.stop()（harnessStopped 门，幂等）
            放行全部窗口 __allowClose=true
            setTimeout(5s) → app.exit(0)    ← 看门狗（quit 序列停摆兜底）
       └─ quit → logCrash('quit')
window-all-closed：isQuiting ? return : 重建窗口（渲染崩溃自愈路径）
```

### 2.6 插件宿主（plugin-host）

- 目录解析（多布局试探）：仓库 `packages/extensions` → `<resources>/extensions` → `app.asar.unpacked/packages/extensions`
- 流程：扫描声明 `deepseek-agent-plugin` 清单的目录 → 启用状态持久化 `userData/plugin-state.json` → 激活产出 `{status, summary}` → 经 IPC `harness:toast` 推送通知
- 社区市场：读取 `defaultPluginsDir()/dsh-market/data/registry-snapshot.json`（离线策展 2452 项），外链经 `plugin:open-external` 用系统浏览器打开

### 2.7 Windows 原生文件夹选择器

`select-directory-win`：PowerShell 承载 WinRT `FolderPicker`，`IInitializeWithWindow` 注入父窗口句柄（模态归属 Electron 窗口）；5 分钟超时/失败回退 Electron 原生对话框。临时 `.ps1` 写 `%TEMP%` 后即删。

## 3. harness 本地后端详细设计

### 3.1 配置（config.ts → HarnessConfig）

来源优先级：环境变量（剥离后 + .env）> 默认值；校验失败启动即抛。

| 字段 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `~/.deepseek-harness`（`DSH_HOME` 可覆盖，支持 `~`） | 会话/技能/设置主目录 |
| `apiKey` | `''`（**无内置**） | DeepSeek Key；`DEEPSEEK_API_KEY(S) > DSH_API_KEY`，历史 `ZHIPU_API_KEY` 为可选覆盖 |
| `baseUrl` | `https://api.deepseek.com` | `DEEPSEEK_BASE_URL / DSH_BASE_URL` 可覆盖 |
| `model` | `deepseek-v4-flash` | `DEEPSEEK_MODEL / DSH_MODEL` 可覆盖 |
| `permission` | `execute` | `HARNESS_PERMISSION` 可覆盖为 read/write |
| `rateLimitMs` | `60000` | `DSH_RATE_LIMIT_MS`；LLM 最小间隔 |
| `maxParallelToolCalls` | `4` | `DSH_MAX_PARALLEL_TOOL_CALLS`（非正整数启动即抛） |
| `persistenceType` | `sqlite` | `DSH_PERSISTENCE`；sqlite（sql.js WASM）→ file 兜底 |
| `sqlitePath` | `<dshHome>/sessions.db` | `DSH_SQLITE_PATH` |
| `mcpServers` | `[]` | `DSH_MCP_SERVERS`（JSON 数组）> `<cwd>/config/mcp-servers.json` > `<exe 同级>/mcp-servers.json` |

### 3.2 服务组装顺序（HarnessApp.start，幂等）

1. SessionStore（持久化：sql.js 优先 → FilePersistence）
2. ToolRuntime → 3. LlmRuntime + DeepSeekAdapter（**共享配置对象引用**：`setApiKey()` 就地改 `apiKey`，请求级生效；无 Key 启动则延迟到填入时注册）→ 4. AgentRegistry → 5. AgentLoop（modlens）→ 6. fs 工具（共享可变 WorkspaceState：运行时切目录/权限立即生效）→ 7. McpRuntime + 服务器装载 → 8. SkillRuntime

DeepSeekAdapter 要点：流式 SSE；`stream_options:{include_usage:true}`（OpenAI 协议默认不回 usage）；`AbortController` 组合取消信号与 `PROVIDER_TIMEOUT_MS` 超时；指数退避重试（≤15s 封顶）；限流闸门 `acquireRateGate(minIntervalMs)`。

### 3.3 Key 运行时注入（跨进程一致）

```
渲染层（设置页）→ ipc 'set-api-key'(key)
  ├─ runtimeApiKey = key.trim()
  ├─ harnessAppRef.setApiKey(key)      # 就地更新共享 config + 延迟注册适配器
  └─ （下次 spawn dsh web 时）baseEnv.DEEPSEEK_API_KEY = runtimeApiKey（若环境未显式配置）
```

### 3.4 会话持久化

`sql.js`（纯 WASM，随包 `node_modules/sql.js`）→ `initSqlJsSessionPersistence(sqlitePath)`；WASM 不可用自动降级 `FilePersistence(sessionsDir)`。会话目录归属受管 `userData/dsh-home/`（dsh web 与 harness 各自使用，互不冲突）。

## 4. 渲染层设计

### 4.1 主窗口内容策略

| 状态 | 内容 |
|---|---|
| dsh web token 就绪 | 官方 dsh-web-ui（DSH 对话工作台） |
| token 未就绪 | 中性 spinner 等待页（`WEB_LOADING_HTML`，无任何浏览器指引文案） |
| 60s 未就绪 | 回退自研 SPA `http://127.0.0.1:5183/` |
| dsh web 彻底不可用 | 静态 `apps/web/dist`（仅展示） |

### 4.2 兜底 SPA 关键机制

- `provider-config.ts`：解析 provider 配置（id `'zhipu'` 为内部历史标识，label 已改为 DeepSeek 官方）；Key 池读取 `DEEPSEEK_API_KEYS > DEEPSEEK_API_KEY > ZHIPU_*`；`withLocalOverrides()` 合并 localStorage 持久化（`dsh-provider-mode/keys/apibase/primary/fallback/tokenbudget`）；守门规则：直连模式 Key 池为空自动回退代理模式；持久化模型必须在受管端点（bigmodel / `/` 代理路径 / `api.deepseek.com`）且在模型清单内，否则清除并回退默认
- 渲染层 Key 同步：`useEffect` 检测 `cfg.keys[0]` → `electronAPI.setApiKey(key)` → 主进程（§3.3）
- 视觉模型判定：命名约定 + 白名单（`modelSupportsVision`）

## 5. IPC 通道清单（preload.cjs → electronAPI）

| 分组 | 通道 |
|---|---|
| Key | `set-api-key`、`get-api-key` |
| 文件 | `read-directory`（同路径并发合并）、`fs-op`（write/read/delete/list，路径穿越校验）、`select-directory`、`select-directory-win`（WinRT） |
| Harness 会话 | `harness:session-create/list/get/send/cancel/delete/rename/event` |
| 工作区 | `harness:set-workspace`、`harness:get-workspace`（持久化 `harness-workspace.json`，启动恢复） |
| MCP | `harness:mcp-add/remove/update-server`、`harness:mcp-list-servers/tools`、`harness:mcp-refresh-tools`、`harness:mcp-test-connection`、`harness:mcp-get-status`、`harness:mcp-event` |
| 技能 | `harness:skill-add` 等 |
| 插件 | `plugin:list`、`plugin:set-enabled`、`plugin:activate`、`plugin:catalog`、`plugin:open-external` |
| 工作台 | `workbench:open`、`workbench:status`、`workbench:scan-extensions` |
| 系统 | `append-log`、`set-auto-launch`、`get-auto-launch`、`harness:toast`（主→渲染推送）、`power-suspend/resume` |

所有 `ipcMain.handle` 经洪水检测包装；渲染进程回调崩溃不阻断主进程。

## 6. 打包流水线（pack-app-asar.mjs）

```
输入：apps/agent-client/{dist, electron, package.json} + apps/web/dist + node_modules/sql.js
stage 过滤：排除 node_modules / .git / *.test.* / *.spec.* / __tests__ / __fixtures__
          （测试文件含 dashscope 等端点常量，绝不随包）
1) asar pack  <stage> app.asar --unpack-dir electron
2) 部署 D:\DeepSeekAgent\resources：
   - 旧 app.asar 备份到 resources\_bak_<ts>（copyFile，防 AV 锁 rename）
   - 覆盖 app.asar + app.asar.unpacked/electron + resources/app/apps/web/dist
3) sql.js 必随包（漏带会导致会话持久化静默退化文件模式）
```

NSIS（installer/DeepSeekAgent.nsi，注释纯 ASCII）：

- 安装：exe/dll/pak 等散文件 + `locales` + `resources/{app.asar, app.asar.unpacked, apps, dsh-runtime, packages}` + 开始菜单/桌面快捷方式 + HKCU 卸载注册键；`RequestExecutionLevel user`（per-user 安装）
- 卸载：`nsExec::Exec 'robocopy /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 <empty> $INSTDIR'`（**无窗口**、零 stdout、防锁死）→ `RMDir /r` 重试 ≤30 次（`IfFileExists` 目录清空即提前退出）→ `/REBOOTOK` → 清快捷方式与注册键

## 7. 错误处理与兜底矩阵

| 故障 | 检测 | 兜底 |
|---|---|---|
| 5183 被占 | listen EADDRINUSE | 端口 +1 重试（≤+20）；仍失败 `logCrash('server-fatal')` |
| 5283 被占/冲突 | bind 预检 + 子进程退出 | 逐端口重试 ≤20 → 静态托管 |
| dsh web 缺 bin | resolveDshBin null | 直接静态回退，不假在线 |
| dsh web 60s 未就绪 | 定时器 | 主窗口回退 SPA(5183) |
| 渲染进程崩溃 | `crashed`/`render-process-gone` | 3s 冷却内 `reload()`；窗口销毁则重建 |
| GPU 崩溃 | child-process-gone | 自动重建 + 落盘日志（已预禁 GPU） |
| 上游 API 挂起 | 20s 无响应头 | abort 上游释放 socket（防 EMFILE） |
| 主进程 OOM | 濒死快照 | 快照落盘供事后定位（进程可能 abort） |
| quit 停摆 | before-quit 后 5s 无 quit | `app.exit(0)` 强制退出 |
| 未捕获异常/拒绝 | uncaughtException/unhandledRejection | `logCrash`，进程不退出 |
| 卸载时文件被 AV 锁 | robocopy/RMDir 失败 | /R:1 /W:1 + 30 次重试 + /REBOOTOK |

## 8. 配置与环境变量总表

| 变量 | 值域/默认 | 作用 |
|---|---|---|
| `DEEPSEEK_API_KEY(S)` | 用户 Key | LLM 凭证（.env 或 UI 设置；启动环境继承会被剥离） |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | api.deepseek.com / deepseek-v4-flash | 端点与模型覆盖 |
| `DSH_TRUST_LAUNCH_ENV` | `1` | 排障：恢复继承启动环境（默认剥离） |
| `DSH_HEADLESS` | `1` | 无窗口（自动化测试；/healthz、/test/mcp/call 启用） |
| `DSH_USER_DATA_DIR` | 路径 | E2E 隔离 userData（绕开单实例锁） |
| `DSH_REMOTE_DEBUGGING_PORT` | 端口 | DevTools 远程调试 |
| `DSH_MAIN_HEAP_MB` | 8192 | 主进程堆上限 |
| `DSH_BUNDLED_NODE` | node.exe 路径 | 排障：指定外部 Node 运行 dsh web |
| `DSH_HOME` / `DSH_PERSISTENCE` / `DSH_SQLITE_PATH` / `DSH_SESSIONS_DIR` | 见 §3.1 | harness 存储布局 |
| `DSH_RATE_LIMIT_MS` / `DSH_MAX_PARALLEL_TOOL_CALLS` | 60000 / 4 | LLM 限流与并发 |
| `DSH_MCP_SERVERS` | JSON 数组 | MCP 服务器清单（亦可用 mcp-servers.json） |
| `DSH_WEB_PROXY_API` | `1`（默认开） | 静态工作台的 API 反代开关 |
| `HARNESS_PERMISSION` | execute/read/write | fs 工具默认权限 |

## 9. 关键时序

### 9.1 冷启动（正常路径）

```
双击 exe → 单实例锁获取 → whenReady
  ├─ loadEnvFile(exe 同级 .env → userData/.env → appPath/.env)
  ├─ server.listen(5183) ── listening → bootApp()
  │     ├─ createWindow()：加载 spinner 等待页
  │     ├─ 60s SPA 兜底定时器挂起
  │     └─ import(harness-dist/app.js) → HarnessApp.start() → restorePersistedWorkspace()
  ├─ startStaticWebServer？（已移除首发；仅兜底）
  └─ startDshWebServer()
        ├─ isPortFree(5283) → spawn dsh web(--no-open)
        ├─ 子进程打印 token URL → captureDshWebToken → win.loadURL(token)
        └─ 主窗口渲染 DSH 对话工作台
```

### 9.2 退出

见 §2.5。实测指标：WM_CLOSE → 进程树清零 + 端口释放 ≤6s（含看门狗路径上界 5s）。

---

*配套文档：《DeepSeekAgent-架构设计说明书.md》（总体架构、技术债与风险）、《DeepSeekAgent-使用说明书.md》。*
