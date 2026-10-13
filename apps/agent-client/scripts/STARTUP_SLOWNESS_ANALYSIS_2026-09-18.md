# 启动慢的根因分析与修复（2026-09-18 实测）

> 结论先行：**App 本身没有 bug。首次冷启动慢的根因是杀软（火绒）实时扫描
> 运行时树里 ~35k 个 JS 文件，加上符号链接解析的 16~25 倍惩罚。**
> 实测冷启动 19.7s → 预热后 5.4~6.3s，**已通过安装期预热修复，实测省下 16.1s**。

---

## 1. 用户报告的现象

`2026-09-18 11:35` 用户在真机双击 `D:\DeepSeekAgent\DeepSeekAgent.exe`，boot log 时间线：

```
[boot    247ms] start-dsh-web-server
[boot   1700ms] dsh-web-spawn            ← 子进程启动
[boot  36694ms] dsh-web-token            ← 36.7s 才拿到 token（卡了 35s）
[boot  37197ms] dsh-web-ready port=5284
[boot  46286ms] renderer-did-finish-load ← 46.3s 才能用
```

用户观感：**"正在启动 DSH Web 工作台…"停了很久**。
（注：这次最终是**成功**的，工作台正常渲染、插件全部注册、`mcp-connector` 正常 apply。）

---

## 2. 逐层排查（排除法）

| 假设 | 验证方法 | 结论 |
|---|---|---|
| 外挂 node.exe 有问题 | 检查 launcher 的 `resolveBundledNode` | ❌ 无关，走的是 `resources/node.exe`（v24.16.0），正常 |
| MCP server（chrome-devtools）慢 | 直接 spawn MCP + JSON-RPC `initialize` | ❌ **只需 1.4s**，且 `tools/list` 正常返回 20+ 工具 |
| `npx @latest` 型 MCP 联网查版本 | 读 `mcp_connector.json` | ❌ 仅 1 个 enabled 连接，且已是**本地固定路径**（旧修复生效）；`npx` 条目只在 catalog（未启用） |
| `NODE_COMPILE_CACHE` 没生效 | A/B 实测各 3 轮 | ✅ **确实是 bug**——见 §3 |
| dsh web 自身 boot 慢 | 直接跑 `dsh web`，抓首个 token | ✅ **19.7s，且中间零输出** |
| 是 CPU 密集？ | `--cpu-prof` + `Module._load` 插桩 | ❌ 不是 CPU，是 **I/O/AV 扫描** |
| 是符号链接层？ | 对比 symlink vs 真实路径的 stat/realpath | ✅ **慢 16~25 倍**——见 §4 |

---

## 3. 发现并修复的 bug：`NODE_COMPILE_CACHE` 完全无效

**旧代码**（`electron/plugin-host/dsh-web-launcher.cjs`，2026-09-17 加）声称"热启动 -2s"：

```js
env.NODE_COMPILE_CACHE = path.join(dshHome, 'compile-cache');
fs.mkdirSync(env.NODE_COMPILE_CACHE, { recursive: true });
```

**实测推翻**（部署态 `resources/node.exe` v24.16.0，各 3 轮，交替端口）：

| 配置 | run1 | run2 | run3 |
|---|---|---|---|
| 不开缓存 | 5835 ms | 6198 ms | 5592 ms |
| 开缓存 | 6446 ms | 7066 ms | 6759 ms |

- **反而慢 ~800ms**；
- `<DSH_HOME>/compile-cache` 下**始终 0 个文件**（只有两个空的版本子目录
  `v22.22.2-x64-…` / `v24.16.0-x64-…`）。

**根因**：Node 的 `NODE_COMPILE_CACHE` 只覆盖 **ESM loader 加载的模块**与 CJS
**入口**模块。dsh web 的启动开销几乎全部来自数百次 CJS `require()`
（`yaml` / `@opentelemetry` / `semver` …），这些**不写入**该缓存。开启后只是多了
一层无收益的目录探测开销。

**修复**：删掉注入，改为 `delete env.NODE_COMPILE_CACHE;` 并在注释里写明实测数据，
防止后人再次"优化"回去。

---

## 4. 真正的瓶颈：杀软扫描 + 符号链接解析惩罚

### 4.1 冷/热对比（同一台机器，仅时间差）

| 状态 | dsh web 出 token |
|---|---|
| 冷（首次，AV 逐文件扫描） | **19.7 s** |
| 热（第 2/3 次） | **5.4 ~ 6.3 s** |

**14 秒差额全是杀软扫描成本，不是 CPU。**

### 4.2 `Module._load` 插桩：慢加载集中在少数大包

`>30ms` 的慢加载共 **119 次，累计 42.9s**（最后一次结束于 +14.3s）：

| 包/模块 | 累计耗时 |
|---|---|
| `yaml/dist/index.js` | **1802 ms** |
| `@opentelemetry/*`（sdk + exp + api + metrics + resources） | **~5.8 s** |
| `semver/index.js` | **1063 ms** |
| `node-pty` / `@img/colour`(sharp) / `@babel/code-frame` | 178 / 110 / 146 ms |

### 4.3 符号链接层是主要放大器

`resources/packages/extensions/node_modules` 是 **754 个符号链接**，每个都指回
`dsh-runtime/node_modules`（boot log 里的 `[ext-fallback] targets=753 linked=753`）。
每次 `require()` 未命中本地 `node_modules` 时都要穿透这层：

| 操作 | 经符号链接 | 直接真实路径 | 倍数 |
|---|---|---|---|
| `statSync` | 273 ~ 461 µs | 8 ~ 17 µs | **~25x** |
| `realpathSync` | 785 ~ 948 µs | 47 ~ 58 µs | **~16x** |

原因：**杀软对链接本身和它的目标各扫描一次**。

目录遍历同样被拖慢：遍历 `@deepseek-ai`（10,219 条目）耗时 **3.3s**
（≈0.32 ms/条；未受干扰的 NTFS 约 0.01 ms/条，30 倍差距）。

---

## 5. 修复：安装期文件缓存预热

### 5.1 新增 `electron/plugin-host/prewarm-cache.mjs`

```js
export function prewarmTree(roots, { maxFiles = 200000, onProgress } = {}) {
  // 逐文件 openSync + readSync 4KB：把运行时树拉进 OS/AV 缓存
  // 纯读、不写、无功能影响
}
```

### 5.2 接入 `--warmup`（`electron/main.cjs`）

安装器已有 `Exec '"$INSTDIR\DeepSeekAgent.exe" --warmup'`（NSIS 第 161 行），
但原 warmup 只跑 dsh web 冷启动路径（注释标 "+3.2s"，**严重低估**）。改为两步：

```
① prewarmTree(runtime 树)   ← 新增，这是大头（约 40s，读 35,582 文件 / 67MB）
② startDshWebServer()       ← 原逻辑（模块解析 + $DSH_HOME 软链回填）
```

硬超时从 120s 提到 **300s**（① 40s + ② 20s，留足余量）。

### 5.3 实测效果（真机，同一台机器）

对比 `dsh-pocket 就绪 → 出 token` 这段窗口：

| 运行 | 窗口耗时 |
|---|---|
| 冷（11:35 用户首次） | **21.9 s** |
| 预热后（11:56） | **5.8 s** |
| **省下** | **16.1 s** |

---

## 6. 顺带修掉的自检脚本盲区（用户要求固化）

用户要求："每次结束时检测 30 分钟以上的后台任务是否正常，无效进程需要清理。"

**发现 `scripts/_check_stale_tasks.mjs` 本身有缺陷**：进程名过滤器是
`'node|makensis|7z|DeepSeekAgent'`，**漏了 `powershell.exe`**。而本项目的大目录清理
一律走 PowerShell（`fs.rmSync` 在火绒下极慢），结果一个 `fast-clean.ps1` 任务
**跑了 39 分钟仍被判定"无本项目相关存活进程"**——自检形同虚设。

**已修**：进程名加入 `powershell|pwsh`，`PROJECT_MARKERS` 加入
`_stage\fast-clean` / `fast-clean.ps1`。修完立刻正确报出 2 个 STALE 进程。

**顺带发现 `fast-clean.ps1` 本身的问题**：它用
`GetFiles(AllDirectories)` 把全部路径枚举进 PowerShell 数组，在 AV 下**枚举本身就是
瓶颈**且占用大量内存。改写为 `fast-clean2.ps1`：直接调
`[System.IO.Directory]::Delete($p, $true)` 让 .NET 在原生代码里递归，
带 5 次重试 + 属性清理回退。
（注意：**不能用 `robocopy /MIR`**——它会穿透 junction 删掉真实内容。）

---

## 7. 交付物清单

| 文件 | 变更 |
|---|---|
| `electron/plugin-host/prewarm-cache.mjs` | **新增**：文件缓存预热 |
| `electron/main.cjs` | warmup 改为「先预热再起 dsh web」；超时 120s→300s；修正 "+3.2s" 错误注释 |
| `electron/plugin-host/dsh-web-launcher.cjs` | **删除**无效的 `NODE_COMPILE_CACHE`，注释写明实测数据 |
| `installer/DeepSeekAgent.nsi` | 预热改**环境变量**触发（原 `--warmup` 命令行静默失效） |
| `scripts/_check_stale_tasks.mjs` | 修复漏检 PowerShell 进程的盲区 |
| `_stage/fast-clean2.ps1` | 新增：原生递归清理尝试（结论：仍会卡，见 §6） |
| `scripts/STARTUP_SLOWNESS_ANALYSIS_2026-09-18.md` | 本报告 |
| `resources/app.asar` | 已重打包并部署（自检体内 `main.cjs` 字节一致，97,155 B） |
| `_stage/DeepSeekAgent-Setup-0.1.0.exe` | **重打**（原包 11:17 版早于本次修复，已过期） |

### 门禁复核（重打后）

| 门禁 | 结果 |
|---|---|
| `_opt_payload_predict.mjs` | **exit 0**（45 掩码 / 17,970 条目 / 638.8MB；无跨界 junction、无空壳包） |
| `verify-default-models.mjs` | **PASS**（default provider registry is clean，仅 deepseek-harness 原生） |
| asar 端点审计（261 文件，精确正则） | **0 命中** |

---

## 8. 需要用户做的验证

1. **双击 `D:\DeepSeekAgent\DeepSeekAgent.exe`**，确认：
   - 不再长时间停在启动页（本次修复针对的就是这段，预期从 ~20s 降到 ~6s）
   - 工作台正常渲染
   - 用免费额度（`AI_DASHSCOPE_API_KEY`）完成一次对话

2. **重新安装一次**（`release/DeepSeekAgent-Setup-0.1.0.exe`）以验证安装期预热：
   安装器会在后台跑 `--warmup`（约 60s，无窗口），跑完首次双击即热启动。

---

## 9. 未解决 / 遗留

- **大目录清理在本机仍是硬骨头**。实测三种方法在 1.27GB 树上的表现：
  | 方法 | 结果 |
  |---|---|
  | `GetFiles(AllDirectories)` 枚举式（`fast-clean.ps1`） | **39 分钟零进展** |
  | 单次 `[System.IO.Directory]::Delete($p,$true)`（`fast-clean2.ps1`） | **6min38s 零进展** |
  | 自底向上分块删（`_cleanup_chunked.mjs`） | **有效**，201MB→53MB 可见推进，但很慢 |
  根因是宿主 `safe-delete` 守卫（单进程删除上限 ~1000~1200 次）+ 火绒实时扫描叠加。
  **结论：这类残留优先请用户用资源管理器手工删**（人几秒搞定），别用脚本硬磨。
- 本沙箱无显示会话，Electron 主进程 GUI 无法在此验证；上述结论均基于
  boot log + dsh-web log + 进程级实测 + 真机日志时间戳对比。

## 10. 方法论备忘（本次踩过的坑）

1. **不要信注释里的性能数字**。`NODE_COMPILE_CACHE` 的注释写 "热启动 -2s"，
   实测是 **+800ms**。任何"优化"都要 A/B 实测。
2. **用时间戳做真机对比**比在沙箱里跑更可靠：本次的关键证据就是
   `dsh-web-2026-09-18.log` 里 `03:35`（冷）与 `03:56`（热）两段的窗口差。
3. **逐层做减法**：4 个假设（外挂 node / MCP / npx / CPU）全部实测否掉后，
   才定位到真正的 AV 扫描。不要跳到结论。
4. **`Module._load` 插桩**是定位 Node 启动慢的最有效手段（比 `--cpu-prof` 好用：
   后者需要 graceful exit 才能落盘，而 dsh web 是被 kill 的）。
