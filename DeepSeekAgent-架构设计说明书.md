# DeepSeekAgent 架构设计说明书

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0 | 2026-09-04 | 首版。对应交付物 `DeepSeekAgent-Setup-0.1.0.exe`（含卸载黑窗修复、环境剥离、退出清场、测试文件剔除） |

---

## 1. 项目定位

DeepSeekAgent 是构建在 **deepseek-harness**（全插件 Cordis 架构的 Agent Harness，仓库主体 `packages/`）之上的 **Windows 桌面客户端**。它本身不实现 Agent 能力，而是做三层适配：

1. **Electron 壳**：窗口、本地 HTTP 服务、进程编排、退出清场、崩溃自愈；
2. **内嵌官方 Web 工作台**：以子进程方式拉起官方 `dsh web`（cordis 运行时），主窗口渲染官方 dsh-web-ui；
3. **本地 Harness 后端**：进程内运行 `electron/harness`（会话、LLM、工具、MCP、技能），供兜底 SPA 与健康检查使用。

核心原则：**上游 harness 零改动**（`packages/` 不因客户端需求而修改），所有客户端特有逻辑收敛在 `apps/agent-client`（外层适配层）。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ DeepSeekAgent.exe（Electron 44.1.1，Chromium 内核）              │
│                                                                 │
│  ┌─────────────────── Electron 主进程（main.cjs）─────────────┐  │
│  │ · HTTP 主后端 :5183（静态 dist + /zhipu 代理 + healthz）   │  │
│  │ · 工作台编排：拉起/监控/清理 dsh web 子进程                 │  │
│  │ · 插件宿主 plugin-host（packages/extensions 扫描/激活）     │  │
│  │ · IPC 网关（~40 个通道，见详细设计 §5）                     │  │
│  │ · 环境剥离 / 单实例锁 / IPC 洪水检测 / OOM 取证 / 退出清场  │  │
│  └──────────────┬──────────────────────────────┬──────────────┘  │
│                 │ spawn(ELECTRON_RUN_AS_NODE)  │ 动态 import      │
│  ┌──────────────▼──────────────┐  ┌────────────▼───────────────┐  │
│  │ dsh web 子进程（同 exe       │  │ harness 本地后端            │  │
│  │ 当 Node 用，cordis 运行时）  │  │ (electron/harness-dist)    │  │
│  │ · 官方 dsh-web-ui + WS API   │  │ · HarnessApp：会话/LLM/    │  │
│  │ · 监听 :5283（冲突自动换口） │  │   工具/MCP/技能/AgentLoop  │  │
│  │ · 一次性 token URL 鉴权      │  │ · sql.js SQLite 会话持久化 │  │
│  └──────────────┬──────────────┘  └────────────┬───────────────┘  │
│                 │ token 就绪 → 主窗口跳转       │ IPC 桥           │
│  ┌──────────────▼──────────────────────────────▼───────────────┐ │
│  │ 渲染进程（主窗口）                                           │ │
│  │ · 首选：官方 dsh-web-ui（DSH 对话工作台）                    │ │
│  │ · 兜底：自研 React SPA（dist/，经 preload IPC 驱动 harness）│ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
          │ HTTPS（用户 Key）                    │ stdio/HTTP
          ▼                                     ▼
   https://api.deepseek.com              MCP 服务器（HTTP/SSE）
```

## 3. 进程与端口规划

| 进程 | 启动方式 | 端口 | 生命周期 |
|---|---|---|---|
| 主进程（GUI） | 双击 exe / `DeepSeekAgent.cmd`（经 `run-agent.js` 以 run-as-node 预启动） | 5183（被占则 +1 递增，上限 +20） | 单实例锁；关闭窗口 → 全量清场退出 |
| dsh web 子进程 | 主进程 spawn，`ELECTRON_RUN_AS_NODE=1` 复用 exe 内置 Node v24，`--expose-internals`（cordis-plugin-hmr 必需） | 5283 起，冲突逐个 +1 扫描（上限 20 个） | 就绪=打印一次性 token URL；退出时按 PID 杀整树 |
| Chromium 子进程 | GPU / Network Utility / Renderer | — | 随主进程 |
| MCP 服务器 | dsh web / harness 按配置拉起（如 `uvx excel-mcp-server`） | 自选 | 随父进程树清理 |

端口分配依据：`5183 = PORT`，`5283 = PORT + 100`。5283 在目标机器上可能被常驻应用（如腾讯元宝）占用，因此**所有端口都做预检 + 冲突扫描**，绝不硬绑。

## 4. 关键设计决策

### 4.1 凭证模型（安全基线）

**规则：包内与启动环境零凭证，Key 一律由用户显式提供。**

- 主进程启动最早期（读取任何 `.env` 之前）**剥离继承环境**中的全部服务商 Key/端点变量：`DEEPSEEK_API_KEY(S)`、`DEEPSEEK_BASE_URL/MODEL`、`DSH_API_KEY/BASE_URL/MODEL`、`ZHIPU_*`、`DASHSCOPE_API_KEY(S)`、`ALIYUN_API_KEYS`、`GLMMODEL_API_KEY`。
  - 背景：曾有机器级 HKCU 环境变量 `DEEPSEEK_API_KEY`（阿里云 Key）被 exe 静默继承，形成"默认自带 Key"的安全观感与串号事故。
- Key 的合法来源（优先级从高到低）：
  1. 应用内设置（渲染进程 `set-api-key` IPC → 主进程内存 + `HarnessApp.setApiKey()` 就地生效，含"启动无 Key、后填 Key"的延迟注册路径）；
  2. `<userData>/.env` → `<exe 同级>/.env` → `<appPath>/.env`（由 `loadEnvFile` 补入，已存在变量优先）。
- dsh web 子进程环境 = 剥离后的主进程环境 +（如 UI 已下发 Key）注入 `DEEPSEEK_API_KEY`；显式删除 `NODE_OPTIONS` 防外部 Node shim 污染 cordis 启动。
- 排障逃生门：`DSH_TRUST_LAUNCH_ENV=1` 恢复旧行为（仅诊断用）。
- 包体交付门控：安装包内不得出现任何 Key 常量与 dashscope/aliyuncs 端点字符串（扫描 `1d652041`/`EDXLXDY`/`CML53A1HXWSC7YUE`/`HARDCODED_ZHIPU_KEY` 等，验收全 0）。

### 4.2 默认服务商：原生 DeepSeek

- LLM 端点 `https://api.deepseek.com`（与 harness 原生 `dsh-llm-deepseek` 的 `PUBLIC_BASE_URL` 一致，不带 `/v1`）；默认模型 `deepseek-v4-flash`，兜底 `deepseek-v4-pro`，另有 `deepseek-v4-flash-vision-exp`。
- 主进程 `/zhipu` 代理（**路径名为历史约定**，上游已是 DeepSeek 官方）：转发时剥离兜底 SPA 携带的智谱风格前缀 `/api/paas/v4`。
- 兜底 SPA 的 provider 内部 `id` 仍为 `'zhipu'`（历史标识，被 localStorage 分桶与适配层引用，改名爆炸半径大）；用户可见 label 已改为「DeepSeek 官方（原生内置 · OpenAI 兼容）」。

### 4.3 工作台加载策略（防"异常残页"）

启动序列（`whenReady`）：

1. `startServer(5183)` 先行（快就绪，承载代理与兜底 SPA）；
2. `createWindow()`：主窗口**首发中性 spinner 等待页**（绝不先加载未注入后端的静态 `apps/web` 页——那会渲染出 `web boot: __ModuleLoader__ missing` 的异常界面）；
3. `startDshWebServer()`：预检端口 → spawn dsh web → 等待 token URL（45s 超时/退出即失败 → 杀子进程换端口重试，最多 20 个）→ 成功后 `captureDshWebToken` 把主窗口跳到 token URL（303 下发 HttpOnly 鉴权 cookie）；
4. 兜底链：dsh web 不可用（缺 bin/全部端口冲突）→ 静态托管 `apps/web/dist`（仅展示）；60 秒未就绪 → 主窗口回退自研 SPA（5183，功能完整）。

历史教训：早期版本 bootApp 先绑 5283 起静态服务再 spawn dsh web，导致子进程 EADDRINUSE 换口、主窗口长期停在残页——已改为静态服务仅作最终兜底。

### 4.4 退出清场（防端口/进程残留）

`before-quit` 触发一次性 `shutdownAllServices()`：

1. `killDshWebChild()` → `killChildTree()`：Windows 上 `taskkill /PID <自录PID> /T /F` 杀**整棵子进程树**（含 dsh web 的 MCP 孙进程）；只按本进程记录的 PID 操作，**绝不按端口或进程名反查**（避免误杀同端口的外部常驻进程）；
2. 关闭 5183 主后端与 5283 工作台监听；
3. `harnessApp.stop()`（幂等，`harnessStopped` 门）；
4. `servicesShutdown` 竞态门贯穿 `startDshWebServer`/`spawnDshWeb`，防止"杀完又生"；
5. **5 秒看门狗**：本机观测到 Electron quit 序列偶发停摆（before-quit 后无 quit 事件、无窗口主进程滞留），超时强制 `app.exit(0)`。

实测：WM_CLOSE 后 ~6 秒进程树清零、自有端口全部释放。

### 4.5 稳定性机制（历史事故驱动）

| 机制 | 针对的历史事故 |
|---|---|
| 禁 GPU 硬件加速 + 全套 GPU 开关（保留 CPU 软光栅化） | Windows 虚拟/受限显示环境下 GPU 进程原生崩溃 → 数秒闪退 |
| 主进程 V8 堆上限 8GB（`--max-old-space-size`）+ 内存采样落盘 | 长会话 OOM（exit 134） |
| IPC 洪水检测（单通道 40 次/秒告警落盘） | 渲染层 effect 死循环 14 秒打爆主进程堆 |
| OOM 濒死快照（堆增长速率 + IPC 直方图） | FATAL abort 绕过 before-quit，事后无现场 |
| 渲染崩溃自动重载（3s 冷却）+ window-all-closed 重建窗口 | 单次渲染崩溃被放大为整客户端退出 |
| 单实例锁（`requestSingleInstanceLock`） | 双击多次起 N 个主进程/N 个 5183 |
| `--expose-internals` 强制 + `NODE_OPTIONS` 清除 | cordis HMR 启动崩溃 / 外部 Node shim 致 dsh-atomic-write 死锁 |

## 5. 打包与交付链

```
源码变更
  ├─ apps/agent-client：tsc --noEmit → vite build（SPA dist）
  ├─ electron/harness：tsc -p（harness-dist）
  └─ pack-app-asar.mjs（自研外科手术打包，绕开 electron-builder 的 AV/下载问题）
       stage：dist + electron + package.json + apps/web/dist + node_modules/sql.js
       排除：node_modules/.git/*.test.*/*.spec.*/__tests__/__fixtures__
       产出：app.asar（--unpack-dir electron）→ 覆盖 D:\DeepSeekAgent\resources
  └─ installer/DeepSeekAgent.nsi（makensis，Solid LZMA，~165MB）
       打包源 = 已验证的 D:\DeepSeekAgent（InstallDir 默认 %LOCALAPPDATA%\Programs\DeepSeekAgent）
```

交付门控（缺一不发）：全量 vitest（基线 524 passed）→ `verify-default-models.mjs`（断言 dsh-runtime 默认 provider/模型/无硬编码 Key）→ 静默安装 → 包体二进制扫描（Key/端点全 0 + 修复标记在包）→ 静默卸载（计时 + 目录清空校验）。

卸载器：`nsExec::Exec` 无窗口运行 `robocopy /MIR`（静默参数 + `/R:1 /W:1` 防锁死）→ `RMDir /r` 重试（30 次上限、目录清空即提前退出）→ `/REBOOTOK` 兜底，删除快捷方式与 HKCU 注册表键。

## 6. 技术债

按影响排序。前三项建议在下个迭代偿还。

| # | 技术债 | 现状与成因 | 影响 | 偿还建议 |
|---|---|---|---|---|
| T1 | **历史标识符 `zhipu` 与 `/zhipu` 路径** | 兜底 SPA 的 provider id、代理路径、环境变量族（`ZHIPU_PROXY` 等）仍用智谱命名，实际上游已是 DeepSeek 官方 | 认知成本；新人极易误判数据流向；审计工具按"zhipu"检索会得出错误结论 | 引入别名常量 + 文档标注，逐步重命名（SPA provider id 需同步 localStorage 迁移逻辑） |
| T2 | **双前端并存** | 官方 dsh-web-ui（主）+ 自研 React SPA（兜底，`src/` 全量维护，约 27 个测试文件） | 双倍 UI 维护成本；SPA 的 provider/代理逻辑与官方 UI 演进不同步 | 官方 UI 稳定后冻结 SPA 功能（仅保留"工作台不可用"兜底形态），逐步删减 SPA 业务屏 |
| T3 | **asar 外科手术式打包** | `pack-app-asar.mjs` 自研 stage→pack→deploy，替代 electron-builder（其在本机被 AV/下载问题阻塞）；文件清单手工维护 | 清单遗漏风险（sql.js 曾漏）；绕过 electron-builder 意味着自动更新、签名、差异升级全部缺失 | 用干净构建机恢复 electron-builder 正式链路，或引入 Squirrel/electron-updater |
| T4 | **harness-dist 为手工编译产物** | `electron/harness-dist` 随包分发，依赖人工执行 `tsc -p` 同步 | 源码与产物漂移风险（本次已发生一次：改了源码忘了 rebuild 的窗口期） | 把 `build:harness` 纳入 pack-app-asar 的强制步骤（脚本已支持，需去掉 `--skip-build` 习惯） |
| T5 | **dsh-runtime 内含上游包测试文件（977+）** | `desktop/runtime-dist` 由 pnpm deploy 生成，上游 npm 包自带 tests/spec 源码 | 体积与审计噪音（曾因此触发 dashscope 扫描误报）；app 代码侧已排除，runtime 侧未处理 | deploy 后追加测试文件剔除步骤，或推动包 files 字段收敛 |
| T6 | **魔法数字与兜底链复杂** | 端口 5183/5283/+20、45s/60s 超时、20 次重试、IPC 阈值 40 等散落 main.cjs | 调参需读代码；多级兜底的行为组合难以穷举测试 | 收敛到顶部常量区 + 配置化（遵循"部署可变项必须可配"约定） |
| T7 | **退出看门狗是症状治疗** | Electron quit 停摆的根因未定位（疑似本机 AV/驱动与 Chromium 交互），用 5s `app.exit(0)` 兜底 | 若根因恶化，5s 内可能仍有资源未及释放 | 在最小复现环境定位 quit 停摆根因 |
| T8 | **NSIS 全量打包慢** | Solid LZMA 压缩 530MB 安装数据，本机 AV 实时扫描使 makensis 5–27 分钟波动 | 迭代反馈慢 | 构建机加 AV 排除目录；或改差量更新方案（依赖 T3） |
| T9 | **同仓库双身份** | 仓库既是 harness 主工程（严格工程约定）又是客户端分发工程（中文交付文档、自定义打包脚本） | 工程约定（doc-sync、覆盖率门控）与客户端快速迭代节奏互相牵制 | 长期考虑客户端拆独立仓库，以 npm 包消费 harness |

## 7. 风险点

| # | 风险 | 场景 | 现有缓解 | 残余风险 |
|---|---|---|---|---|
| R1 | **凭证泄露** | 用户 `.env` 明文放 exe 旁随项目同步；`userData/.credentials.yaml` 存 UI 下发的 Key | 无内置 Key；环境剥离；.credentials 仅本机 | .env 被误提交/误分享（文档已警示；可加 Key 脱敏日志） |
| R2 | **端口被外部常驻应用占用** | 5283 被腾讯元宝等占用 | 逐端口扫描 + 静态回退 + 主窗口兜底链 | 极端情况下 20 个端口全占 → 工作台不可用（SPA 兜底仍可用） |
| R3 | **杀软对未签名 exe 的干扰** | 实时扫描拖慢文件操作（electron-builder 曾 >25min）、瞬锁文件 | 卸载重试循环、robocopy 扩展路径、`/REBOOTOK`；启动器实测可双击运行 | 未签名 → SmartScreen 提示；不同杀软行为不可枚举。**建议购买代码签名证书** |
| R4 | **dsh web 子进程启动失败链路** | cordis boot 失败、profile junction 失效、userData 旧状态污染（曾发生：`.credentials.yaml` 旧智谱 Key + settings.yaml 阿里云配置残留） | 端口重试、静态回退、60s SPA 兜底；`prepareDshHome` 幂等重建 profile | 用户 userData 内旧状态导致的失败模式仍需人工清数据（已补清理文档） |
| R5 | **主进程 OOM / 渲染失控** | 长会话 + 大目录树读取 | 8GB 堆、洪水检测、MAX_FILES/MAX_FILE_SIZE 限制、read-directory 并发合并 | 恶性输入组合（超大工作区 + 高频刷新）仍可逼近上限 |
| R6 | **升级覆盖与数据兼容** | 新包覆盖旧安装；userData 中旧 settings.yaml/credentials 与新版本语义冲突 | 卸载器清目录；安装不触碰 userData；本文档记录清理步骤 | userData schema 无版本号，跨大版本升级需人工干预 |
| R7 | **Electron 平台行为不确定** | quit 停摆（已用看门狗兜底）、GPU 驱动差异 | 看门狗、禁 GPU、崩溃自愈 | Chromium/Electron 升级（44 → 更新）需全量回归 |
| R8 | **快照/单测盲区** | vitest 覆盖 SPA 与 harness 单元；dsh-web 端到端链路（token/端口/子进程）只能靠运行时烟测脚本 | 已建立可复用的生命周期烟测（启动→就绪→WM_CLOSE→清场校验） | 烟测未纳入 CI；平台矩阵（仅 Win10/11 x64 验证） |
| R9 | **多实例与单实例锁边界** | 用户数据目录被外部工具（如 `DSH_USER_DATA_DIR` 测试）并发使用 | 单实例锁按 userData 隔离 | 并发写同一 dsh-home 未加跨进程文件锁 |
| R10 | **机器级环境变量残留** | 本机 HKCU 仍存 `DEEPSEEK_API_KEY`（阿里云）与 `DEEPSEEK_BASE_URL`；exe 已忽略，但命令行 `dsh`、其他工具仍会读到 | exe 侧已剥离（本文档 §4.1） | 用户机器层面的清理待用户确认执行 |

## 8. 演进方向（建议）

1. **签名与自动更新**（解决 R3 + T3/T8 的根）：代码签名证书 + electron-updater；
2. **SPA 降级为纯兜底壳**（T2）：删减业务屏，只留"工作台不可用"提示 + 基础对话；
3. **userData schema 版本化**（R6）：`dsh-home/meta.json` 记录版本，启动时迁移/清理；
4. **运行时烟测进 CI**（R8）：把生命周期烟测脚本固化为 `pnpm test:exe-smoke`；
5. **标识符去智谱化**（T1）：一次性重命名 PR + localStorage 迁移。

---

*配套文档：《DeepSeekAgent-详细设计说明书.md》（模块/接口/时序级）、《DeepSeekAgent-使用说明书.md》（安装配置运维）。*
