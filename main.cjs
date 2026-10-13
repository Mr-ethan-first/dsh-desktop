'use strict';
/**
 * Electron 主进程（外层，不触碰 deepseek-harness）。
 *
 * 设计要点：
 * - 在本地同源起一个 HTTP 服务（默认 5183），既服务 Vite 构建出的 dist 静态资源，
 *   又接管 /zhipu/* 代理（历史路径名）：把请求转发到 DeepSeek 官方端点并注入用户 Key。
 * - 渲染进程（兜底 SPA）在「代理模式」下只请求同源 /zhipu/...，密钥绝不进入前端包体。
 * - 不内置任何 API Key。Key 来源优先级：UI 运行时下发 > process.env > <userData>/.env >
 *   <exe 同级>/.env > <appPath>/.env。未配置时提示用户在设置中自行填入 DeepSeek API Key。
 * - 无头自动化测试端点：/healthz（就绪状态 + MCP 连接诊断）、/test/mcp/call（调用回传验证）。
 *   两者仅在 DSH_HEADLESS=1 或 DSH_TEST=1 时启用，不泄漏到生产 GUI。
 */
const { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } = require('electron');
const http = require('node:http');
const childProcess = require('node:child_process');
const { scanLocalExtensions } = require('./plugin-host/scan-extensions.cjs');
const { resolveDshLaunch: dshResolveLaunch, spawnDshWeb: dshSpawn } = require('./plugin-host/dsh-web-launcher.cjs');
const { shouldProxyUrl, forwardRequest } = require('./plugin-host/api-proxy.cjs');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// ============================================================
// 环境隔离：绝不隐式继承「启动环境里的服务商 Key / 端点」
// ============================================================
// 事故背景：本机曾在 HKCU 环境变量里设置 DEEPSEEK_API_KEY（实为阿里云 Key）与
// DEEPSEEK_BASE_URL，exe 双击启动时静默继承 → 用户观感即「默认自带内置 key、
// 还指向非原生端点」。Key 必须由用户在应用内显式配置，不来自任何隐式环境。
// 保留的显式配置路径（按优先级）：应用内设置（set-api-key IPC） > userData/.env >
// exe 同级 .env > appPath/.env（均在 whenReady 里 loadEnvFile 补进 process.env）。
// 排障逃生门：DSH_TRUST_LAUNCH_ENV=1 时按旧行为原样继承（仅用于诊断）。
if (process.env.DSH_TRUST_LAUNCH_ENV !== '1') {
  for (const k of [
    'DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEYS', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
    'DSH_API_KEY', 'DSH_BASE_URL', 'DSH_MODEL',
    'ZHIPU_API_KEY', 'ZHIPU_API_KEYS', 'ZHIPU_API_BASE', 'ZHIPU_PRIMARY_MODEL', 'ZHIPU_MODEL',
    'DASHSCOPE_API_KEY', 'DASHSCOPE_API_KEYS', 'ALIYUN_API_KEYS', 'GLMMODEL_API_KEY',
  ]) {
    delete process.env[k];
  }
}

// ============================================================
// 启动期稳定性与诊断（必须在 app.whenReady 之前设置）
// ============================================================
// 1) 禁用硬件加速：聊天类 UI 对 GPU 无强依赖，软件渲染足够。
//    这是 Windows 上「打开数秒后整客户端闪退」的最常见根因（GPU 进程原生崩溃）。
try {
  app.disableHardwareAcceleration();
} catch {
  /* 某些平台不支持，忽略 */
}
// 命令行层面再强制禁用 GPU 硬件加速。
// 重要：本机为虚拟/受限显示环境，之前为兜底 GPU 进程自杀而启用的 --enable-unsafe-swiftshader
// 反而让 Chromium 尝试创建 swiftshader 的 GLES 上下文，失败后报
// "ContextResult::kFatalFailure: Failed to create shared context for virtualization"，
// 进而触发进程间歇性原生崩溃（0x80000003 断点），表现为「打开数秒后无操作闪退」。
// 因此这里的策略是「禁用 GPU，但保留 CPU 软件光栅化」：
//   ✅ 禁用 GPU / GPU 合成 / GPU 沙箱 / GPU watchdog，并禁用 Vulkan 与硬件视频解码，
//      让 Chromium 完全走 CPU 路径，不创建 GLES 上下文，从而避免 swiftshader 的致命失败。
//   ⚠️ 绝不能再加 --disable-software-rasterizer：真实窗口需要光栅化才能绘制，
//      关掉软件光栅化后，窗口一旦需要重绘就会 FATAL abort，表现为运行十几秒后
//      exit code 134 / SIGABRT 的间歇性闪退。离屏(offscreen)测试不会重绘，因此测不出该问题。
//   ⚠️ 也不要把 UseSkiaRenderer 放进 disable-features：Skia 正是 CPU 光栅化的提供者。
try {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-gpu-watchdog');
  app.commandLine.appendSwitch(
    'disable-features',
    'HardwareAcceleratedVideoDecode,Vulkan,UseChromeOSDirectVideoDecoder,AcceleratedVideoDecodeLinuxGL',
  );
} catch {
  /* 忽略 */
}
// 主进程 V8 堆上限：默认旧空间上限电子应用偏低，LLM 对话 / 长会话 / 记忆重放
// 下可持续增长并触发 "JavaScript heap out of memory"（exit code 134 自动退出）。
// 显式放宽到 8GB，并对超阈值增长落盘告警日志，便于事后定位泄漏。
const MAIN_HEAP_LIMIT_MB = parseInt(process.env.DSH_MAIN_HEAP_MB || '8192', 10);
if (Number.isInteger(MAIN_HEAP_LIMIT_MB) && MAIN_HEAP_LIMIT_MB > 0) {
  app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${MAIN_HEAP_LIMIT_MB}`);
}
// 可选：E2E / 远程调试用的 DevTools 端口。仅当显式设置 DSH_REMOTE_DEBUGGING_PORT 时开启，
// 生产环境默认关闭（不影响任何用户行为）。打包后的 exe 不转发未知 argv，故用 env 触发而非命令行 flag。
if (process.env.DSH_REMOTE_DEBUGGING_PORT) {
  try {
    app.commandLine.appendSwitch('remote-debugging-port', String(process.env.DSH_REMOTE_DEBUGGING_PORT));
    console.error('[app] remote debugging 已开启于端口', process.env.DSH_REMOTE_DEBUGGING_PORT);
  } catch (e) {
    console.error('[app] 无法开启 remote debugging:', e && (e.stack || e.message));
  }
}
// 可选：E2E 隔离用的独立 userDataDir。设置后应用使用临时配置目录，避免与已运行的生产实例
// 争用 single-instance 锁 / 残留 DevToolsActivePort 导致二次启动立即退出。生产默认不设置。
if (process.env.DSH_USER_DATA_DIR) {
  try {
    app.setPath('userData', process.env.DSH_USER_DATA_DIR);
    console.error('[app] userData 指向', process.env.DSH_USER_DATA_DIR);
  } catch (e) {
    console.error('[app] 无法设置 userData:', e && (e.stack || e.message));
  }
}
// 内存监控：每 10s 采样主进程内存，接近阈值或异常增长时落盘（<tmp>/dsh-agent-logs/mem-*.log）。
// 尽早启动、低粒度采样：历史 OOM（启动约 14s 内堆从 0 爬到 3.5GB）在延迟 60s 的监控里根本观测不到。
// 不阻塞、不退出，仅观测——帮助区分「真实业务需要」与「失控泄漏」。
setTimeout(() => {
  const M = 1024 * 1024;
  const flashPointRatio = 0.85;
  let prevMB = 0;
  const timer = setInterval(() => {
    try {
      const rss = process.memoryUsage().rss;
      const mb = Math.floor(rss / M);
      const heapMB = Math.floor(process.memoryUsage().heapUsed / M);
      const over = mb >= Math.floor(MAIN_HEAP_LIMIT_MB * flashPointRatio);
      if (over || mb - prevMB > 128) {
        try {
          const dir = diagLogsDir();
          fs.appendFileSync(
            path.join(dir, `mem-${new Date().toISOString().slice(0, 10)}.log`),
            `[${new Date().toISOString()}] rss=${mb}MB heapUsed=${heapMB}MB` + (over ? ' ⚠ 接近堆上限' : ' Δ大') + '\n',
            'utf8',
          );
        } catch {
          /* 日志失败不影响运行 */
        }
      }
      prevMB = mb;
    } catch {
      /* 采样失败忽略 */
    }
  }, 10_000);
  timer.unref();
}, 5_000);
// 2) 详细日志落地：原生崩溃（GPU / 渲染进程）会写入 <固定临时目录>/electron-<date>.log。
//    注意：便携 exe 的真实 userData 是运行时才由 electron-builder 重定向的，
//    在 app 就绪前用 app.getPath('userData') 算出的路径不可靠（会落空或落错），
//    因此诊断日志统一写到 os.tmpdir() 下固定目录，保证一定能找到。
function diagLogsDir() {
  try {
    const dir = path.join(os.tmpdir(), 'dsh-agent-logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return path.join(process.cwd(), 'dsh-agent-logs');
  }
}
const DIAG_DIR = diagLogsDir();

// ============================================================
// 启动阶段计时（供性能回归与用户报障定位）
// ============================================================
// 写盘到 <tmp>/dsh-agent-logs/boot-<date>.log，单行一次标记，含两个时间轴：
//   1) 相对标记 0：主进程模块开始求值（即 Electron 已完成自身引导）
//   2) proc+：相对进程创建（process.uptime），含 Electron 引导与 Chromium 初始化
// 便于回答「用户从双击到看见 dsh-web-ui 的时间都花在哪一段」。
const BOOT_T0 = Date.now();
const BOOT_PROC_T0_MS = Math.round(process.uptime() * 1000);
function bootMark(name, extra) {
  const line =
    `[boot ${String(Date.now() - BOOT_T0).padStart(6)}ms | proc+${String(Math.round(process.uptime() * 1000)).padStart(6)}ms] ` +
    `${name}${extra === undefined || extra === null ? '' : ' ' + extra}`;
  try {
    fs.appendFileSync(path.join(DIAG_DIR, `boot-${new Date().toISOString().slice(0, 10)}.log`), line + '\n', 'utf8');
  } catch {
    /* 落盘失败不影响运行 */
  }
  console.error(line);
}
bootMark('module-eval-start', `electron=${process.versions.electron} node=${process.versions.node} procT0=${BOOT_PROC_T0_MS}ms`);

try {
  const elog = path.join(DIAG_DIR, `electron-${new Date().toISOString().slice(0, 10)}.log`);
  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', elog);
  // 日志冗长级别默认(0)。曾用 -v 1（全量 verbose），会把 Chromium 各子系统逐行刷进 log-file，
  // 空闲也能在一天内撑到数百 MB（658MB），并叠加磁盘 IO 与 CPU 开销；故降回默认级别。
  // crash / startup / agent 等业务诊断日志仍照常独立落盘，不受影响。
  // 启动标记：落盘后用户一定能在本目录找到崩溃日志
  fs.writeFileSync(
    path.join(DIAG_DIR, `startup-${new Date().toISOString().slice(0, 10)}.log`),
    [
      `[startup] ${new Date().toISOString()}`,
      `[startup] electron 详细日志写入: ${elog}`,
      `[startup] 崩溃日志(crash-*.log) / 渲染日志(agent-*.log) 同目录: ${DIAG_DIR}`,
      `[startup] process.execPath = ${process.execPath}`,
      `[startup] ELECTRON_DISABLE_GPU = ${process.env.ELECTRON_DISABLE_GPU || '(unset)'}`,
    ].join('\n') + '\n',
    'utf8',
  );
  console.error('[startup] 诊断日志目录:', DIAG_DIR);
} catch {
  /* 忽略日志初始化失败 */
}

const DIST_DIR = path.join(__dirname, '..', 'dist');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');
const PORT = 5183;
let SERVER_PORT = PORT;

// 插件工作台（Plugin Workbench）：内嵌官方 DSH web 前端（apps/web 的构建产物），
// 让社区插件在真实的浏览器 DOM + Cordis web 上下文里真正挂载运行（与上游 dsh web 一致），
// 而非仅「展示」。前端静态资源由独立端口的静态服务托管，非静态（API）请求反向代理到主后端。
// 解析应用根目录：开发态 __dirname = <repo>/apps/agent-client/electron/plugin-host；
// 打包态 Electron 把代码放在 <resourcesPath>/app 下，__dirname = <resourcesPath>/app/electron/plugin-host。
// 因此用 process.resourcesPath 区分两种布局，避免「../..」层数算错导致路径指飞。
const APP_ROOT = process.resourcesPath
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..', '..', '..');
const WEB_DIST_DIR = path.join(APP_ROOT, 'apps', 'web', 'dist');
const WEB_SERVER_PORT = PORT + 100; // 5283，避免与主服务冲突
// 端口冲突兜底：dsh web 的 cordis webServer 没有内置端口回退（原生 server 有
// EADDRINUSE→port+1，dsh web 没有）。一旦 WEB_SERVER_PORT 被别的进程占用，
// dsh web 的 boot() 会在 server.listen 阶段抛 EADDRINUSE 失败、子进程退出；而旧逻辑里
// spawnDshWeb() 只判断 cp.spawn 是否成功就 return true，于是主进程误以为 dsh web 已托管
// 该端口、不回退静态、也不换端口 —— 结果该端口上没有任何监听者，前端 /api/*、/plugins/events、
// /api/remote.mux 全部 ERR_CONNECTION_REFUSED（现象：「选不了工作目录 / 桥接全断」）。
// 这里显式做端口预检 + 就绪门控 + 失败换端口重试，彻底消除该单点故障。
const WEB_PORT_MAX_RETRY = 20;
let WEB_SERVER_PORT_RESOLVED = WEB_SERVER_PORT;
// dsh web 真正打印出 token URL（=cordis boot 成功且 webServer 已 listen）后由
// captureDshWebToken 触发的就绪回调；未就绪前主进程不会把 workbenchBaseUrl 指过去。
let dshWebReadyResolve = null;
let webServer = null;
// 选项一：自己接管插件扫描。上游 `dsh web` 不读「扩展目录」env，而是通过 DSH_HOME
// 下的 profile（profiles/web 的 dsh.profile.bundles）发现插件。因此我们准备一个受管
// DSH_HOME，把仓库内 vendored 的 packages/extensions 写进 web profile 并软链进其
// node_modules，再让 dsh web 子进程继承 DSH_HOME——社区插件即可真实挂载。
// 社区插件真实目录：打包态落在 <resources>/packages/extensions（与 defaultPluginsDir
// 候选 1 一致，且该目录为真实目录便于 prepareDshHome 软链进 web profile 的 node_modules），
// 开发态落在 <repo>/packages/extensions。原先写成 APP_ROOT/packages/extensions
// （= <resources>/app/packages/extensions）在打包产物里并不存在，导致社区插件永不被发现。
const EXTENSIONS_DIR = process.resourcesPath
  ? path.join(process.resourcesPath, 'packages', 'extensions')
  : path.join(__dirname, '..', '..', '..', '..', 'packages', 'extensions');
let workbenchBaseUrl = null;
// dsh web 启动时会打印一个一次性 token URL（http://127.0.0.1:<port>/?token=...），
// 访问它才会下发鉴权 cookie（HttpOnly, SameSite=Strict），之后才能正常渲染应用。
// 直接访问 / 会返回 401，因此 BrowserWindow 必须先走这个 token URL 完成 bootstrap。
let workbenchAuthUrl = null;
// 记录「token URL 是否已被某个窗口消费过」（cookie 在默认 session 内共享），
// 避免第二个窗口重复消费（token 可能为一次性）导致 401。
let workbenchCookieSet = false;
// dsh web 冷启动（tsx 编译）可能耗时；超过该时长仍未就绪则主窗口回退旧前端，
// 保证客户端始终可用，不卡在加载页。
const DSH_WEB_READY_TIMEOUT_MS = 45000;
/** dsh web 尚未就绪时的主窗口占位页（不启动旧 SPA，待 token 就绪即跳转）。 */
const WEB_LOADING_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>正在加载工作台</title><style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#0f1115;color:#cfd6e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.spin{width:34px;height:34px;border:3px solid #2a2f3a;border-top-color:#4f8cff;border-radius:50%;animation:r 0.9s linear infinite;margin:0 auto 16px}
@keyframes r{to{transform:rotate(360deg)}}.t{text-align:center;font-size:14px;color:#9aa4b2}</style></head>
<body><div><div class="spin"></div><div class="t">正在启动 DSH Web 工作台…</div></div></body></html>`;
const WEB_LOADING_DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(WEB_LOADING_HTML);
let dshWebChild = null;
/** 退出清理只执行一次（顶层可见：startDshWebServer / spawnDshWeb 的防「杀完又生」竞态门）。 */
let servicesShutdown = false;
/** harness 只停一次（before-quit 与窗口 closed 双入口共用）。 */
let harnessStopped = false;

/** 受管的 DSH_HOME（社区插件 profile 写入此处）。app ready 后才可调用 app.getPath。 */
function resolveDshHomeDir() {
  try { return path.join(app.getPath('userData'), 'dsh-home'); }
  catch { return path.join(os.tmpdir(), 'deepseek-agent-dsh-home'); }
}

/**
 * 解析 dsh CLI 启动方式，返回 { bin, nodeArgs } 或 null。
 *
 * 背景：本仓库是 pnpm workspace，`@deepseek-ai/dsh` 是 workspace 包（apps/cli），
 * root `node_modules/.bin/dsh` 并不存在，所以不能只找 bin 命令，必须支持
 * 「node + 入口文件」两种形态：
 *   - 已构建：<repo>/apps/cli/lib/bin.js  → node lib/bin.js web --port N
 *   - 源码态：<repo>/apps/cli/src/bin.ts  → node --import tsx/esm src/bin.ts web --port N
 *
 * 打包态需要把 apps/cli 整包（含 lib/ 与其 node_modules）随 electron-builder 带走，
 * 否则这里返回 null → dsh web 不起 → 主窗口回退旧前端。
 * @returns {{bin:string, nodeArgs:string[]}|null}
 */
/** 随包运行时（dsh-runtime）所在的 resources 根目录。 */
function resourcesRootForRuntime() {
  return process.resourcesPath || APP_ROOT;
}

function resolveDshBin() {
  // 打包态随包带走的 cordis 运行时（electron-builder extraResources → <resourcesPath>/dsh-runtime）。
  // 注意：只用 lib/bin.js 入口（node 直接跑），不要用 .bin/dsh shim（spawn 给 node 当脚本会失败）。
  const resourcesRoot = resourcesRootForRuntime();
  const bundledCliDir = path.join(resourcesRoot, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh');

  // 候选的真实可执行命令（安装态优先）
  const extraBins = [
    path.join(APP_ROOT, 'node_modules', '.bin', 'dsh'),
    path.join(APP_ROOT, '..', 'node_modules', '.bin', 'dsh'),
    path.join(APP_ROOT, 'apps', 'cli', 'node_modules', '.bin', 'dsh'),
  ].filter((p) => { try { return fs.existsSync(p); } catch { return false; } });

  // 候选的 CLI 包目录（开发态=仓库根/apps/cli；打包态=<resourcesPath>/dsh-runtime 下的 @deepseek-ai/dsh）
  const cliDirs = [
    bundledCliDir,
    path.join(APP_ROOT, 'apps', 'cli'),
    path.join(APP_ROOT, '..', 'apps', 'cli'),
    path.join(APP_ROOT, 'cli'),
  ];
  for (const cliDir of cliDirs) {
    const launch = dshResolveLaunch({ cliDir, extraBins });
    if (launch) return launch;
  }
  // 最后再单独试一次 extraBins（CLI 包目录都不存在、但有全局/随包 dsh 命令的情况）
  return dshResolveLaunch({ cliDir: null, extraBins });
}

/**
 * 解析运行 dsh 所用的 Node 可执行文件。
 *
 * Electron 44.1.1 内置 Node v24.18.1（Chromium 152 / V8 15.2），已完整满足 dsh 运行时
 * 对 Node 24+ 的要求（node:zlib.createZstdDecompress、node:module.stripTypeScriptTypes 等）。
 * 因此**不再随包外挂约 92MB 的 node.exe**，改为复用 Electron 二进制自身：
 * 给 Electron 可执行文件设置 `ELECTRON_RUN_AS_NODE=1` 时，它等价于一个纯 Node
 * 进程——不拉起 Chromium、不创建窗口，可直接执行 JS 入口脚本。
 *
 * 优先级：DSH_BUNDLED_NODE（显式覆盖 / 排障保留）→ Electron 内置 Node → 系统 node。
 * @returns {{runtime:string, runAsNode:boolean, source:string}}
 */
function resolveBundledNode() {
  // 排障兜底：仍允许用 DSH_BUNDLED_NODE 指向任意外部 node.exe（内置 Node 出问题时可一键切回）。
  const envNode = process.env.DSH_BUNDLED_NODE;
  if (envNode && fs.existsSync(envNode)) {
    return { runtime: envNode, runAsNode: false, source: 'DSH_BUNDLED_NODE' };
  }
  // 运行在 Electron 内（开发态 electron . 或打包态 exe）→ 复用内置 Node。
  if (process.versions && process.versions.electron) {
    return { runtime: process.execPath, runAsNode: true, source: 'electron-builtin' };
  }
  // 纯 node 运行（vitest 单测 / CLI 场景）：用当前解释器即可。
  return { runtime: process.execPath, runAsNode: false, source: 'system-node' };
}

/**
 * 构造 dsh web 子进程的 baseEnv。
 * 复用 Electron 内置 Node 时必须显式注入 ELECTRON_RUN_AS_NODE=1，否则子进程会按 GUI
 * 应用启动（创建窗口而不是执行脚本）；反之则必须清掉该变量，避免外层启动器残留污染。
 * @returns {{base:NodeJS.ProcessEnv, node:{runtime:string, runAsNode:boolean, source:string}}}
 */
function buildDshWebBaseEnv() {
  const node = resolveBundledNode();
  const base = { ...process.env };
  // UI 下发的用户 Key（如有且环境未显式配置）透传给 dsh web，供原生 deepseek provider 使用。
  if (runtimeApiKey && !base.DEEPSEEK_API_KEY) base.DEEPSEEK_API_KEY = runtimeApiKey;
  if (node.runAsNode) base.ELECTRON_RUN_AS_NODE = '1';
  else delete base.ELECTRON_RUN_AS_NODE;
  return { base, node };
}

/**
 * 从 dsh web 子进程日志里抓取一次性 token URL，并在主窗口尚未 bootstrap 时立即跳转过去
 * （让 BrowserWindow 经 303 拿到鉴权 cookie，随后渲染应用）。
 * @param {string} msg
 */
function captureDshWebToken(msg) {
  // 日志形如：dsh web: http://127.0.0.1:5283/?token=xxxx
  const m = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+)/.exec(msg || '');
  if (!m) return;
  workbenchAuthUrl = m[1];
  // 后续工作台的基地址也应指向 dsh web 后端，而不是静态 fallback。
  try { workbenchBaseUrl = workbenchAuthUrl.replace(/\?token=[^&]+/, '/'); } catch { /* ignore */ }
  // 通知等待 dsh web 就绪的调用方（startDshWebServer 的端口回退/就绪门控逻辑）。
  if (dshWebReadyResolve) {
    const r = dshWebReadyResolve;
    dshWebReadyResolve = null;
    try { r(); } catch { /* ignore */ }
  }

  bootMark('dsh-web-token', workbenchAuthUrl);
  if (mainWindow && !workbenchCookieSet && !mainWindow.isDestroyed()) {
    workbenchCookieSet = true;
    console.error('[web-server] dsh web 鉴权地址就绪，主窗口跳转工作台：', workbenchAuthUrl);
    bootMark('window-navigate-workbench');
    mainWindow.loadURL(workbenchAuthUrl);
  }
}

function spawnDshWeb() {
  const launch = resolveDshBin();
  if (!launch) {
    console.error('[web-server] 未找到 dsh CLI（既无 node_modules/.bin/dsh，也无 apps/cli 的 lib/bin.js 或 src/bin.ts），回退静态托管（社区插件可能无法完整挂载）。');
    return false;
  }
  const dshHome = resolveDshHomeDir();
  const { base: baseEnv, node: nodeRuntime } = buildDshWebBaseEnv();
  console.error(
    `[web-server] dsh runtime: ${nodeRuntime.runtime} (source=${nodeRuntime.source}` +
    `${nodeRuntime.runAsNode ? ', ELECTRON_RUN_AS_NODE=1' : ''})`,
  );
  bootMark('dsh-web-spawn', `bin=${launch.bin}`);
  // 插件共享解析回退的宿主目录：运行时 node_modules。安装包里插件自身的
  // node_modules（全是指向此处的 junction）已被剔除（NSIS 会把 junction 展开成
  // 真实目录，且同一棵 @deepseek-ai 在两条路径各展开一次 → 载荷虚增约 750MB），
  // 改由 prepareDshHome → ensureExtensionsModuleFallback 在首次启动时重建共享回退。
  const runtimeModulesDir = path.join(resourcesRootForRuntime(), 'dsh-runtime', 'node_modules');
  const child = dshSpawn({
    bin: launch.bin,
    runtimeModulesDir,
    // cordis-plugin-hmr 要求 node 暴露 internal 模块（loader.internal），
    // 否则 dsh web boot 会抛 "--expose-internals is required for HMR service" 并退出，
    // 导致 dsh-web-ui（富页面）无法托管，Electron 主窗口只剩回退页。复用内置 Node
    // 或外部 node 都必须带此 flag。
    nodeArgs: ['--expose-internals', ...launch.nodeArgs],
    runtime: nodeRuntime.runtime,
    port: WEB_SERVER_PORT_RESOLVED,
    dshHome,
    extensionsDir: EXTENSIONS_DIR,
    baseEnv,
    childProcess,
    onLog: (m) => { console.error(m); captureDshWebToken(m); },
  });
  if (!child) {
    console.error('[web-server] spawn dsh web 失败（无法启动子进程）。');
    return false;
  }
  dshWebChild = child;
  // 竞态兜底：清理恰好发生在本次 spawn 期间 → 立刻杀掉，不留「杀完又生」。
  if (servicesShutdown) {
    killDshWebChild();
    return false;
  }
  return true;
}

/**
 * 快速预检端口是否可 bind（127.0.0.1）。返回 Promise<boolean>。
 * 仅用于降低「把已占用端口喂给 dsh web 导致其 boot 失败」的概率；真正兜底靠
 * waitDshWebReady 的子进程退出检测（存在微小 TOCTOU 竞争，预检无法完全消除）。
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * 精确终止一个由本进程亲自 spawn 的子进程**及其全部后代**（端口回退重试 / 退出清理共用）。
 * 只按已记录的 PID 杀树，绝不做按端口或按进程名的批量查杀（避免误杀外部同端口进程）。
 * @param {import('node:child_process').ChildProcess|null} child
 */
function killChildTree(child) {
  if (!child || child.pid == null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    // taskkill 独立进程执行，本进程随后退出也不影响它把整棵子进程树杀干净。
    try {
      const tk = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, detached: true, stdio: 'ignore',
      });
      tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
      tk.unref();
      return;
    } catch { /* 落到直接 kill */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/** 杀掉当前 dsh web 子进程（重试换端口/退出前清理残留，含后代，避免端口泄漏）。 */
function killDshWebChild() {
  if (dshWebChild) {
    killChildTree(dshWebChild);
    dshWebChild = null;
  }
}

/**
 * 等待 dsh web 真正就绪（打印 token URL = cordis boot 成功且 webServer 已 listen），
 * 或判定失败（子进程在就绪前退出 / 超时）。返回 Promise<boolean>。
 * @param {number} port 本次尝试的端口（仅用于日志）
 */
function waitDshWebReady(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // 防御：若 token URL 在 spawnDshWeb 与本次设置 resolver 之间已到达（极端竞态），直接判就绪。
    if (workbenchAuthUrl) {
      console.error(`[web-server] dsh web 端口 ${port} 在进入等待前已捕获 token，直接判就绪`);
      return done(true);
    }
    const onExit = (code) => {
      if (!workbenchAuthUrl && !settled) {
        console.error(`[web-server] dsh web 子进程在就绪前退出 (code=${code == null ? 'null' : code})，端口 ${port} 可能冲突或 boot 失败`);
        done(false);
      }
    };
    if (dshWebChild) dshWebChild.on('exit', onExit);
    // captureDshWebToken 捕获 token URL 时会调用 dshWebReadyResolve
    dshWebReadyResolve = () => done(true);
    setTimeout(() => {
      if (!settled) console.error(`[web-server] dsh web 端口 ${port} 就绪超时 (${DSH_WEB_READY_TIMEOUT_MS}ms)，回退/换端口`);
      done(false);
    }, DSH_WEB_READY_TIMEOUT_MS);
  });
}

const PROXY_PREFIX = '/zhipu'; // 历史路径名：兜底 SPA 与 vite dev 中间件均按此约定请求
/** DeepSeek 官方 OpenAI 兼容端点（原生内置服务商）。 */
const UPSTREAM_API = 'https://api.deepseek.com';
/**
 * 上游连接空闲超时（毫秒）。
 * EMFILE 根因修复：当外部 LLM API 不可达/挂起时，handleProxy 的 https.request
 * 若不设超时，socket 会一直挂起 → FD 表被耗尽 → 后续会话落盘 writeFileSync 抛
 * EMFILE（表现为「新建看不出效果 / 对话不可用」）。
 * 仅在「尚未收到响应头」时计时；一旦上游开始回流（SSE 正常推送）立即清零，
 * 因此不会误杀正常的慢速流式响应，只回收「连上了但不回数据」的僵尸连接。
 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 20000;

/** 上游固定为 DeepSeek 官方；去掉兜底 SPA 携带的智谱风格路径前缀（/api/paas/v4）。 */
function resolveUpstream(bodyText, reqUrl) {
  const path = (reqUrl || '').replace(/^\/api\/paas\/v4/, '');
  return UPSTREAM_API + path;
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.pnpm', '.vscode', '.idea']);
const MAX_FILES = 2000;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** 简易 .env 解析（仅补充未设置的变量，已存在的优先）。 */
function loadEnvFile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null) process.env[key] = val;
    }
  } catch {
    /* 文件不存在则忽略 */
  }
}

/** 运行时由渲染进程经 IPC 设置的 API Key（优先于环境变量）。 */
let runtimeApiKey = '';

/** 取用户配置的 Key 池：UI 下发 > 环境变量（DeepSeek 优先）。包内不内置任何 Key。 */
function getKeys() {
  if (runtimeApiKey) return [runtimeApiKey];
  const raw =
    process.env.DEEPSEEK_API_KEYS ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.DSH_API_KEY ||
    process.env.ZHIPU_API_KEYS ||
    process.env.ZHIPU_API_KEY ||
    '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 静态资源服务（SPA 回退到 index.html）。 */
function serveStatic(req, res, root = DIST_DIR) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const isNavigation = urlPath === '/' || !path.extname(urlPath);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // 仅「导航请求（无扩展名的 HTML 页面）」才回退到 index.html；
      // 静态资源（.js/.css/.png 等）若缺失必须如实 404，绝不能伪装成 text/html，
      // 否则浏览器按严格 MIME 校验拒绝模块脚本 → 整页白屏且难以排查。
      if (isNavigation) {
        filePath = path.join(root, 'index.html');
        fs.readFile(filePath, (e2, buf) => {
          if (e2) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, {
            'content-type': MIME['.html'],
            'cache-control': 'no-cache',
          });
          res.end(buf);
        });
      } else {
        console.error(`[serveStatic] 缺失静态资源(${urlPath})，返回 404（避免白屏）`);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('asset not found: ' + urlPath);
      }
      return;
    }
    fs.readFile(filePath, (e2, buf) => {
      if (e2) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(buf);
    });
  });
}

/**
 * 启动自检：旧自研 SPA（apps/agent-client/src + dist）已移除，主窗口只加载官方
 * dsh-web-ui，不再有需要自检的本地前端产物。保留空实现，避免改动调用点。
 */
function selfCheckDist() {
  // no-op：旧 SPA 已删除，无本地前端产物需要自检。
}

/** 过滤会干扰分块传输的响应头。 */
function filterHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
    out[k] = v;
  }
  return out;
}

/** /zhipu 代理：按 model 字段路由到正确上游并注入密钥（流式原样透传）。 */
function handleProxy(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const bodyText = body.toString('utf8');
    const target = resolveUpstream(bodyText, (req.url || '').replace(/^\/zhipu/, ''));

    // settled：防止 up 的 error 与 response 两次写入 res（客户端已断开时常见）。
    let settled = false;
    const fail = (status, payload) => {
      if (settled) return;
      settled = true;
      try {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {
        /* res 已关闭，忽略 */
      }
    };

    /**
     * 发起上游请求：Key 只来自 getKeys()（UI 下发 / 用户环境变量）。
     * 未配置 Key 时不注入 Authorization，由上游返回 401，前端提示用户到设置里填 Key。
     */
    const attempt = () => {
      if (settled) return;
      const headers = { 'content-type': 'application/json' };
      {
        const keys = getKeys();
        if (keys[0]) headers['authorization'] = 'Bearer ' + keys[0];
      }

      const up = https.request(
        target,
        { method: req.method || 'POST', headers },
        (r) => {
          // 客户端已断开：直接消费并丢弃上游响应，释放 socket（避免泄漏）。
          if (res.destroyed || res.writableEnded) {
            r.resume();
            return;
          }
          settled = true;
          res.writeHead(r.statusCode || 502, filterHeaders(r.headers));
          r.pipe(res);
        },
      );

      // 上游连接/响应头空闲超时：回收「连上但不回数据」的僵尸 socket（EMFILE 根因）。
      up.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => {
        try { up.destroy(new Error('upstream connect timeout')); } catch { /* ignore */ }
      });
      // 一旦上游开始回流（收到响应头），停止连接计时；正常 SSE 推送不会被误杀。
      up.on('response', () => { try { up.setTimeout(0); } catch { /* ignore */ } });

      up.on('error', (e) => {
        // 记录真实失败码（ECONNRESET/ETIMEDOUT/…）便于定位「socket hang up」属于连接层还是响应前被主动销毁。
        const ec = e && e.code ? String(e.code) : '';
        const em = String((e && e.message) || e);
        logCrash('proxy-upstream', `target=${target} code=${ec} ${em}`);
        fail(502, { error: em, code: ec, proxyTarget: target });
      });

      // 仅在「上游尚未开始响应」且客户端连接真正断开时才中止上游，避免 HTTP
      // IncomingMessage 的 'close' 在请求读完(‘end’)后立刻触发而误杀尚未回包的请求。
      const onClientGone = () => {
        try {
          if (!settled && !up.destroyed) up.destroy();
        } catch { /* ignore */ }
      };
      res.on('close', onClientGone);

      if (body.length) up.write(body);
      up.end();
    };

    attempt();
  });
}

// 健康检查 / 无头自动化测试用全局状态
let harnessAppRef = null;
let harnessReady = false;
let harnessError = null;
const appStartTime = Date.now();

/** 崩溃/异常统一落盘：写到 userData/logs/crash-<date>.log（JSON 单行），便于事后无复现排查。 */
function logCrash(kind, detail) {
  try {
    const entry = {
      kind,
      at: new Date().toISOString(),
      uptimeMs: Date.now() - appStartTime,
      detail: typeof detail === 'string' ? detail : (detail && (detail.stack || JSON.stringify(detail))) || '',
    };
    const logsDir = DIAG_DIR;
    fs.mkdirSync(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(logsDir, `crash-${date}.log`), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* 落盘失败也不应影响主流程 */
  }
  console.error(`[crash:${kind}]`, detail && (detail.stack || detail));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/healthz') return handleHealthz(req, res);
  if (url === '/test/mcp/call') return handleTestMcpCall(req, res);
  if (url.startsWith(PROXY_PREFIX)) return handleProxy(req, res);
  return serveStatic(req, res);
});
server.on('error', (e) => console.error('[server] error:', e && (e.stack || e.message)));

// ============================================================
// 插件工作台（Plugin Workbench）：内嵌官方 DSH web 前端
// ------------------------------------------------------------
// 社区插件（genui / better-sidebar / at-file / TUI 等）hook 的是 DSH web 的
// DOM / Composer / 侧边栏上下文；在 Node 主进程里 Cordis 无 DOM 而无法挂载。
// 因此把官方 `apps/web` 构建产物作为静态服务托管，由独立端口暴露，
// 主窗口通过「打开插件工作台」在新 BrowserWindow 里加载它——
// 插件在真实浏览器 Cordis 上下文里真正挂载运行（与上游 dsh web 完全一致），不重复造轮子。
// ============================================================

/** 工作台暂不可用时的静默等待页（不再引导用户去浏览器/构建，定时自动重试加载）。 */
const WEB_WORKBENCH_FALLBACK_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>DeepSeek Agent</title><meta http-equiv="refresh" content="5"><style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;background:#0f1115;color:#cfd6e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.spin{width:34px;height:34px;border:3px solid #2a2f3a;border-top-color:#4f8cff;border-radius:50%;animation:r 0.9s linear infinite;margin:0 auto 16px}
@keyframes r{to{transform:rotate(360deg)}}.t{text-align:center;font-size:14px;color:#9aa4b2}</style></head>
<body><div><div class="spin"></div><div class="t">正在准备本地工作台，请稍候…</div></div></body></html>`;

/** 把非静态（API / SSE 等）请求反向代理到主后端，使内嵌 web 前端的后端调用可达。
 *  默认关闭，由环境变量 DSH_WEB_PROXY_API=1 开启（需用户确认 DSH web 的 API 契约与上游一致）。 */
function proxyWebToBackend(req, res) {
  forwardRequest(req, res, {
    targetBaseUrl: `http://127.0.0.1:${SERVER_PORT}`,
    httpModule: http,
    onLog: (m) => console.error(m),
  });
}

/**
 * 静态回退：托管 apps/web/dist（仅展示，社区插件可能因缺清单而无法挂载）。
 * 非静态（API）请求代理回本地主后端（Key 不暴露给前端）。额外做端口空闲预检，
 * 避免回退服务也踩端口冲突。
 * @returns {Promise<import('node:http').Server|null>}
 */
async function startStaticWebServer() {
  if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
    console.error('[web-server] ⚠️ 未找到 apps/web/dist/index.html，且 dsh web 不可用；插件工作台将降级为提示页（请先构建 web，或确保 dsh web 可执行）。');
    return null;
  }
  if (!(await isPortFree(WEB_SERVER_PORT_RESOLVED))) {
    for (let p = WEB_SERVER_PORT; p < WEB_SERVER_PORT + WEB_PORT_MAX_RETRY; p++) {
      if (await isPortFree(p)) { WEB_SERVER_PORT_RESOLVED = p; break; }
    }
  }
  const ws = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const hasExt = /\.[a-z0-9]+$/i.test(urlPath);
    if (hasExt) return serveStatic(req, res, WEB_DIST_DIR);
    // 默认开启 API 代理：把 web 前端的 API 类请求指回本地主后端（端口 SERVER_PORT），
    // API Key 仅存于主进程/后端，绝不暴露给前端页面。
    if (shouldProxyUrl(urlPath)) {
      return proxyWebToBackend(req, res);
    }
    return serveStatic(req, res, WEB_DIST_DIR);
  });
  ws.on('error', (e) => console.error('[web-server] error:', e && (e.stack || e.message)));
  ws.listen(WEB_SERVER_PORT_RESOLVED, '127.0.0.1', () => {
    console.error(`[web-server] 插件工作台静态服务已启动: http://127.0.0.1:${WEB_SERVER_PORT_RESOLVED}/`);
  });
  workbenchBaseUrl = `http://127.0.0.1:${WEB_SERVER_PORT_RESOLVED}/`;
  return ws;
}

/**
 * 启动插件工作台服务（带端口回退 + 就绪门控，修复「原生桥接全断」单点故障）。
 * 优先拉起官方 dsh web 服务端（注入 window.__DSH_BOOT__ 插件清单，社区插件真正挂载）。
 * 从 WEB_SERVER_PORT 起逐个探测空闲端口：预检端口空闲 → spawn dsh web → 等待其打印
 * token URL（=cordis boot 成功且 webServer 已 listen）才确认「在线」；若子进程在就绪前
 * 退出（端口冲突 / boot 失败）或超时，则杀掉子进程、换下一个端口重试，直到命中空闲端口
 * 或穷尽重试次数，最后回退静态托管（绝不「假在线」导致工作台桥接全断）。
 * @returns {Promise<import('node:http').Server|null>}
 */
async function startDshWebServer() {
  bootMark('start-dsh-web-server');
  for (let i = 0; i < WEB_PORT_MAX_RETRY; i++) {
    // 退出清理已开始：绝不再拉起新子进程（否则「杀完又生」导致端口残留）。
    if (servicesShutdown) return null;
    const port = WEB_SERVER_PORT + i;
    WEB_SERVER_PORT_RESOLVED = port;
    if (!(await isPortFree(port))) {
      console.error(`[web-server] 端口 ${port} 预检被占用，尝试 ${port + 1}`);
      continue;
    }
    // 内部准备受管 DSH_HOME 的 web profile（注入社区插件）+ 软链，并用 WEB_SERVER_PORT_RESOLVED 拉起子进程。
    const launched = spawnDshWeb();
    if (!launched) {
      console.error('[web-server] 无法启动 dsh web 子进程（缺 bin/运行时），直接进入静态回退');
      break;
    }
    const ok = await waitDshWebReady(port);
    if (ok) {
      bootMark('dsh-web-ready', `port=${port}`);
      console.error(`[web-server] dsh web 已在端口 ${port} 就绪（token URL 已捕获），工作台由 dsh web 托管`);
      workbenchBaseUrl = `http://127.0.0.1:${port}/`;
      return null; // dsh web 已占用该端口并托管前端
    }
    // 失败：清理本轮子进程，换端口重试
    killDshWebChild();
  }
  // 所有端口尝试失败 / 无法启动子进程 → 静态回退（降级但可用，不假在线）
  console.error('[web-server] dsh web 不可用，回退静态托管 apps/web/dist');
  return startStaticWebServer();
}

let workbenchWindow = null;

/**
 * 让一个 BrowserWindow 加载 DSH web 前端：
 * - 若一次性 token URL 已就绪且尚未被消费，先走 token URL（303 下发 cookie），
 *   之后自动跳转到应用首页；cookie 在默认 session 内共享，后续窗口直接加载 / 即可。
 * - 若 dsh web 已就绪但 token URL 暂未捕获（理论上不会），加载基础地址 /。
 * - 若 dsh web 完全不可用（workbenchBaseUrl 为 null），降级提示页。
 * @param {import('electron').BrowserWindow} win
 */
function workbenchLoadUrl(win) {
  if (workbenchAuthUrl && !workbenchCookieSet) {
    workbenchCookieSet = true;
    console.error('[web-server] 工作台窗口经 token URL 启动鉴权：', workbenchAuthUrl);
    win.loadURL(workbenchAuthUrl);
  } else if (workbenchBaseUrl) {
    win.loadURL(workbenchBaseUrl);
  } else {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(WEB_WORKBENCH_FALLBACK_HTML));
  }
}

/** 打开（或聚焦）插件工作台窗口：加载内嵌 DSH web 前端；未构建时降级提示页。 */
function createPluginWorkbenchWindow() {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.focus();
    return workbenchWindow;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: PRELOAD_PATH,
    },
  });
  workbenchWindow = win;
  workbenchLoadUrl(win);
  // 拦截 window.open / target="_blank"：强制用系统浏览器打开。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (workbenchWindow === win) workbenchWindow = null;
  });
  return win;
}

ipcMain.handle('workbench:open', async () => {
  try {
    createPluginWorkbenchWindow();
    return { ok: true };
  } catch (e) {
    logCrash('workbench-open', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('workbench:status', async () => ({
  webDistExists: fs.existsSync(path.join(WEB_DIST_DIR, 'index.html')),
  webServerPort: webServer ? WEB_SERVER_PORT_RESOLVED : null,
  workbenchBaseUrl,
  extensionsDir: EXTENSIONS_DIR,
  dshWebRunning: !!(dshWebChild && !dshWebChild.killed),
}));

/** 扫描本地 vendored 插件目录（packages/extensions），返回可供 UI 展示与「分发加载」的清单（选项一）。 */
ipcMain.handle('workbench:scan-extensions', async () => {
  try {
    const extDir = EXTENSIONS_DIR;
    const items = scanLocalExtensions(extDir);
    return { ok: true, dir: extDir, items, error: null };
  } catch (e) {
    logCrash('workbench-scan-extensions', e);
    return { ok: false, dir: null, items: [], error: String((e && e.message) || e) };
  }
});

// 主进程级异常全部捕获并落盘，但绝不退出进程（避免单点异常导致整个客户端闪退）。
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

// ============================================================
// IPC 洪水检测（防御与诊断）
// ============================================================
// 按通道统计 1s 内调用频率；某通道异常高频（疑似渲染进程失控死循环）时落盘告警，
// 为「启动后几秒自动退出 + 主进程堆暴涨 OOM」类问题提供定位证据。
// 历史教训：渲染进程曾因工作区刷新 effect 反馈死循环，每 ~150ms 无限调用 read-directory
// （主进程 readDirTree 全量读目录、建 JSON），14 秒把主进程 V8 堆顶到 OOM 后 SIGABRT 退出。
const IPC_FLOOD_THRESHOLD = 40;
const ipcCallCounts = new Map();
let ipcFloodWindowStart = Date.now();
let ipcFloodLoggedAt = 0;
function withIpcFloodWatch(channel, handler) {
  return async (...args) => {
    const now = Date.now();
    if (now - ipcFloodWindowStart >= 1000) {
      ipcCallCounts.clear();
      ipcFloodWindowStart = now;
    }
    const c = (ipcCallCounts.get(channel) || 0) + 1;
    ipcCallCounts.set(channel, c);
    if (c >= IPC_FLOOD_THRESHOLD && now - ipcFloodLoggedAt > 3000) {
      ipcFloodLoggedAt = now;
      logCrash(
        'ipc-flood',
        `channel=${channel} 调用 ${c} 次/秒 heap=${Math.floor(process.memoryUsage().heapUsed / 1048576)}MB`,
      );
    }
    return handler(...args);
  };
}
{
  const _handle = ipcMain.handle.bind(ipcMain);
  // withIpcFloodWatch(channel, handler)：注意参数顺序。
  // 这里若把 fn 与 channel 写反（withIpcFloodWatch(fn, channel)），handler 实参变成字符串通道名，
  // 包装器里 `handler(...args)` 会对字符串调用 → 每个 IPC 都抛 TypeError，
  // 渲染进程 unhandledrejection → appendLog → 又抛 … 形成 40~165 次/秒的 IPC 死循环（CPU 打满 + OOM 诱因）。
  ipcMain.handle = (channel, fn) => _handle(channel, withIpcFloodWatch(channel, fn));
}

// ============================================================
// 失控/濒死检测（FATAL OOM 的现场取证）
// ============================================================
// 主进程 V8 OOM 是 C++ 级 abort：触发前不会走 process 'before-quit'/'quit'，
// 也不会被 uncaughtException 捕获，因此普通 crash-*.log 一片空白（历史 OOM 时
// crash-*.log 恒为 0 字节）。这里用一个轻量高频监视器：一旦堆进入「快速增长」或
// 「接近默认旧空间上限(~3.5GB)」危险区，就把当时的 IPC 频道直方图 + 堆/RSS 快照
// 落盘到 <tmp>/dsh-agent-logs/oom-snapshot-*.log。FATAL abort 会让最后几行现场
// 保留，事后无需复现即可定位是哪个频道在刷屏。
const OOM_HIGH_WATER_MB = 1400; // 正常会话不会无谓升到这么高，过了即视为疑似失控
const OOM_SNAPSHOT_COOLDOWN_MS = 2000;
let oomLastSnapshotAt = 0;
function heapRunawaySnapshot(reason) {
  try {
    const now = Date.now();
    if (now - oomLastSnapshotAt < OOM_SNAPSHOT_COOLDOWN_MS) return;
    oomLastSnapshotAt = now;
    const mu = process.memoryUsage();
    const rows = [...ipcCallCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([ch, n]) => `${ch}=${n}/s`)
      .join('  ');
    const line =
      `[${new Date().toISOString()}] ${reason} heap=${Math.floor(mu.heapUsed / 1048576)}MB ` +
      `rss=${Math.floor(mu.rss / 1048576)}MB ` +
      (rows ? `topIpc={${rows}}` : 'topIpc=(-)');
    fs.appendFileSync(
      path.join(DIAG_DIR, `oom-snapshot-${new Date().toISOString().slice(0, 10)}.log`),
      line + '\n',
      'utf8',
    );
  } catch {
    /* 快照失败不影响主流程 */
  }
}
{
  const M = 1024 * 1024;
  let prevHeapMB = Math.floor(process.memoryUsage().heapUsed / M);
  let prev = Date.now();
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      const heapMB = Math.floor(process.memoryUsage().heapUsed / M);
      const dtSec = Math.max(0.001, (now - prev) / 1000);
      const rateMBs = Math.max(0, (heapMB - prevHeapMB) / dtSec);
      prev = now;
      prevHeapMB = heapMB;
      if (heapMB >= OOM_HIGH_WATER_MB || rateMBs > 256) {
        heapRunawaySnapshot(
          heapMB >= OOM_HIGH_WATER_MB ? `heap=${heapMB}MB>=阈值` : `增长≈${Math.round(rateMBs)}MB/s`,
        );
      }
    } catch {
      /* 采样失败忽略 */
    }
  }, 200);
  timer.unref();
}


/** 无头健康检查端点：暴露 harness 就绪状态与 MCP 服务器连接诊断，供自动化测试断言 exe 内部状态。 */
function handleHealthz(_req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const diag =
    harnessAppRef && typeof harnessAppRef.diagnosis === 'function'
      ? harnessAppRef.diagnosis()
      : { ready: false, mcpServers: [] };
  res.end(
    JSON.stringify({
      ok: true,
      uptimeMs: Date.now() - appStartTime,
      harness: {
        ready: harnessReady,
        error: harnessError ? String(harnessError.message || harnessError) : null,
      },
      mcpServers: diag.mcpServers,
      version: app.getVersion(),
      electron: process.versions.electron || null,
    }),
  );
}

/**
 * 测试专用 MCP 工具调用端点（仅测试模式暴露，避免泄漏到生产 GUI）。
 * 仅当 DSH_HEADLESS=1 或 DSH_TEST=1 时启用；其它情况返回 404。
 * 用于自动化测试验证「配置注入 → 连接 → 工具发现 → 调用 → 回传」全链路。
 */
function handleTestMcpCall(req, res) {
  if (process.env.DSH_HEADLESS !== '1' && process.env.DSH_TEST !== '1') {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'test endpoint disabled' }));
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { serverId, tool, args } = JSON.parse(body || '{}');
      if (!serverId || !tool) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'serverId and tool required' }));
      }
      const mcp = harnessAppRef && harnessAppRef.ctx && harnessAppRef.ctx.mcp;
      if (!mcp || typeof mcp.callMcpTool !== 'function') {
        res.statusCode = 503;
        return res.end(JSON.stringify({ ok: false, error: 'mcp runtime not ready' }));
      }
      const result = await mcp.callMcpTool(serverId, tool, args || {});
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, content: result }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
  });
}

/** 递归读取目录为文件树；限制文件数量与大小，避免卡死。 */
async function readDirTree(dirPath, relativePath = '', counters = { files: 0 }) {
  const entries = [];
  const dirents = await fs.promises.readdir(path.join(dirPath, relativePath), { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isDirectory() && IGNORE_DIRS.has(dirent.name)) continue;
    const childRel = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
    const id = `fs-${childRel}`;
    if (dirent.isDirectory()) {
      const children = await readDirTree(dirPath, childRel, counters);
      entries.push({ id, name: dirent.name, type: 'dir', path: childRel, children });
    } else if (dirent.isFile()) {
      if (counters.files >= MAX_FILES) continue;
      const fullPath = path.join(dirPath, childRel);
      let content = '';
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.size <= MAX_FILE_SIZE) {
          content = await fs.promises.readFile(fullPath, 'utf8');
        } else {
          content = `/* 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，仅展示路径 */`;
        }
      } catch {
        content = '';
      }
      counters.files++;
      entries.push({ id, name: dirent.name, type: 'file', path: childRel, content });
    }
  }
  return entries;
}

let mainWindow = null;
/** 渲染进程崩溃后自愈的重载冷却：避免崩溃循环里无限刷新。 */
let lastCrashReloadAt = 0;
const CRASH_RELOAD_COOLDOWN_MS = 3000;

// ============================================================
// 插件运行时（plugin-host）
// ============================================================
// 集成仓库内 packages/extensions/ 下所有声明了 deepseek-agent-plugin 清单的插件：
// 扫描发现 → 解析清单 → 持久化启用状态 → 通过 IPC 暴露到渲染进程「插件市场」。
// 插件宿主用 ESM（package.json type: module），因此在 CJS 主进程里通过动态 import 加载。

/**
 * 插件目录：仓库内所有 extension 插件所在父目录（每个子目录一个插件包）。
 * 需兼容多种运行布局（开发态 / 打包态），逐一试探返回第一个真实存在的目录：
 *  - 开发态：<repo>/packages/extensions
 *  - 打包态（extraResources 拷贝到 resources/extensions）：<resources>/extensions
 *  - 打包态（随 app 进 asar.unpacked）：<resources>/app.asar.unpacked/packages/extensions
 * 旧实现写死 `../../../packages/extensions`，在两种布局下都指向不存在的目录，
 * 导致插件宿主扫到 0 个插件（即 modlens/node-flow/market 全部「声明但未发现」的根因之一）。
 */
function defaultPluginsDir() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', 'packages', 'extensions'),
    path.join(__dirname, '..', '..', '..', 'extensions'),
    path.join(__dirname, '..', '..', 'app.asar.unpacked', 'packages', 'extensions'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[0];
}

let pluginHostRef = null;

/** 把 Cordis 插件经 ctx.toast 发出的通知，经 IPC 推到渲染进程的 ToastCenter。 */
function sendToastToRenderer(payload) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('harness:toast', payload);
  } catch {
    /* 窗口不可用：忽略 */
  }
}

/** 动态加载 plugin-host 并初始化（幂等）。 */
async function ensurePluginHost() {
  if (pluginHostRef) return pluginHostRef;
  const hostPath = path.join(__dirname, 'plugin-host', 'index.js');
  try {
    const mod = await import(pathToFileURL(hostPath).href);
    const stateFile = path.join(app.getPath('userData'), 'plugin-state.json');
    // 注入 Cordis 宿主所需的桥接服务（仅暴露本客户端已有能力，避免过度造轮子）。
    pluginHostRef = mod.createPluginHost({
      pluginsDir: defaultPluginsDir(),
      stateFile,
      cordis: {
        toast: sendToastToRenderer,
        fs,
        electron: { shell },
      },
    });
    return pluginHostRef;
  } catch (e) {
    logCrash('plugin-host-init', e);
    pluginHostRef = { pluginHostFailed: String((e && e.message) || e) };
    return pluginHostRef;
  }
}

function reloadWindowSafely(win) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (now - lastCrashReloadAt < CRASH_RELOAD_COOLDOWN_MS) {
    // 冷却期内再次崩溃：不再重载（避免死循环），仅记录，交由用户手动重启。
    logCrash('render-reload-skipped', '崩溃过于频繁，已停止自动重载以避免循环');
    return;
  }
  lastCrashReloadAt = now;
  try {
    logCrash('render-reload', '渲染进程崩溃，尝试自动重载恢复');
    win.reload();
  } catch (e) {
    logCrash('render-reload-failed', e);
  }
}

function createWindow() {
  try {
    // DSH_OFFSCREEN=1：无头渲染窗口（不显示，但仍加载页面、运行渲染进程），
    // 仅用于自动化复现渲染期崩溃，不影响真实 GUI（默认 show:true）。
    const offscreen = process.env.DSH_OFFSCREEN === '1';
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: !offscreen,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: PRELOAD_PATH,
      },
    });
    mainWindow = win;
    bootMark('window-created', `offscreen=${offscreen}`);
    // 渲染层就绪节点：dom-ready = 文档解析完（等待页会立刻到达）；did-finish-load = 首帧
    // 资源全部加载完。工作台跳转后这两个节点再次触发，是「看见界面」的最接近可测信号。
    win.webContents.on('dom-ready', () => bootMark('renderer-dom-ready', win.webContents.getURL().slice(0, 60)));
    win.webContents.on('did-finish-load', () => bootMark('renderer-did-finish-load', win.webContents.getURL().slice(0, 60)));
    // 关闭控制权：默认拦截 X 关闭 → 走正常退出流程；仅在 before-quit 时放行，
    // 避免：渲染进程崩溃导致窗口被销毁 → window-all-closed → 误判为「用户退出」而整 app 退出。
    win.__allowClose = false;
    win.on('close', (e) => {
      if (!win.__allowClose) {
        e.preventDefault();
        try {
          app.quit();
        } catch {
          /* 忽略 */
        }
      }
    });

    // 渲染进程崩溃/消失：落盘日志并自动重载恢复，而不是让整个客户端闪退退出。
    win.webContents.on('crashed', (_event, _details) => {
      logCrash('webcontents-crashed', 'renderer process crashed');
      reloadWindowSafely(win);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      logCrash('render-process-gone', details || 'renderer process gone');
      reloadWindowSafely(win);
    });

    // 拦截 window.open / target="_blank"：强制用系统浏览器打开，而非在 Electron 内新建窗口。
    // 修复：用户点「在浏览器中打开」时不再新开 DeepSeekAgent 窗口。
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // 主窗口渲染官方 dsh-web-ui（由 startWebServer 拉起的 dsh web 后端注入 __DSH_BOOT__）。
    // dsh web 启动会打印一次性 token URL；token 就绪前先显示等待页（绝不先加载未注入的
    // 静态 apps/web 页——那会渲染出「web boot: ModuleLoader missing」的异常界面），
    // captureDshWebToken 会在就绪瞬间把主窗口跳转过去；旧自研 SPA 兜底已移除。
    if (workbenchAuthUrl) {
      win.loadURL(workbenchAuthUrl);
      workbenchCookieSet = true;
    } else {
      win.loadURL(WEB_LOADING_DATA_URL);
    }
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    return win;
  } catch (e) {
    logCrash('create-window-failed', e);
    return null;
  }
}

ipcMain.handle('set-api-key', async (_event, key) => {
  runtimeApiKey = typeof key === 'string' ? key.trim() : '';
  // 运行时下发的 Key 立即应用到 harness（含「启动时无 Key、之后才填入」的延迟注册路径）。
  try {
    if (harnessAppRef && typeof harnessAppRef.setApiKey === 'function') {
      harnessAppRef.setApiKey(runtimeApiKey);
    }
  } catch (e) {
    console.error('[ipc] set-api-key 应用失败:', e && (e.message || e));
  }
  return Boolean(runtimeApiKey);
});

ipcMain.handle('get-api-key', async () => (runtimeApiKey ? 'set' : ''));

// ========== 插件市场 IPC ==========
/** 列出已发现插件（含启用状态），返回可直接用于前端渲染的清单。 */
ipcMain.handle('plugin:list', async () => {
  try {
    const host = await ensurePluginHost();
    if (host.pluginHostFailed) return { ok: false, error: host.pluginHostFailed, plugins: [] };
    const discovered = host.list();
    const plugins = discovered.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description || '',
      version: p.version || '',
      capabilities: p.capabilities || [],
      entry: p.entry || null,
      ui: p.ui || null,
      enabled: Boolean(p.enabled),
    }));
    return { ok: true, plugins };
  } catch (e) {
    logCrash('plugin-list', e);
    return { ok: false, error: String((e && e.message) || e), plugins: [] };
  }
});

/** 启用/禁用指定插件，返回最新启用状态。 */
ipcMain.handle('plugin:set-enabled', async (_event, name, value) => {
  try {
    const host = await ensurePluginHost();
    if (host.pluginHostFailed) return { ok: false, enabled: false, error: host.pluginHostFailed };
    const enabled = host.setEnabled(String(name), Boolean(value));
    return { ok: true, enabled, error: null };
  } catch (e) {
    logCrash('plugin-set-enabled', e);
    return { ok: false, enabled: false, error: String((e && e.message) || e) };
  }
});

/** 激活（或重新激活）指定插件，返回激活记录（status/summary），供前端展示集成状态。 */
ipcMain.handle('plugin:activate', async (_event, name) => {
  try {
    const host = await ensurePluginHost();
    if (host.pluginHostFailed) return { ok: false, error: host.pluginHostFailed, record: null };
    const target = host.list().find((p) => p.name === String(name));
    if (!target) return { ok: false, error: `未找到插件: ${name}`, record: null };
    const rec = await host.activate(target);
    return { ok: true, record: rec, error: null };
  } catch (e) {
    logCrash('plugin-activate', e);
    return { ok: false, error: String((e && e.message) || e), record: null };
  }
});

/** 读取官方 dsh-market 离线策展注册表（2452 个社区插件），返回归一化目录，供客户端「社区市场」展示。 */
let _catalogCache = null;
ipcMain.handle('plugin:catalog', async () => {
  try {
    if (_catalogCache) return { ok: true, items: _catalogCache, error: null };
    const regPath = path.join(defaultPluginsDir(), 'dsh-market', 'data', 'registry-snapshot.json');
    const data = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const items = (Array.isArray(data.plugins) ? data.plugins : []).map((p) => ({
      name: p.name || '',
      owner: p.owner || '',
      url: p.url || '',
      page: p.page || '',
      category: p.category || '',
      description: (p.description && (p.description.en || p.description.zh)) || '',
      stars: typeof p.stars === 'number' ? p.stars : 0,
      tarball: p.tarball || '',
      install: p.install || '',
    }));
    _catalogCache = items;
    return { ok: true, items, error: null };
  } catch (e) {
    logCrash('plugin-catalog', e);
    return { ok: false, items: [], error: String((e && e.message) || e) };
  }
});

/** 用系统浏览器打开外部链接（社区市场「查看 / 安装」）。 */
ipcMain.handle('plugin:open-external', async (_event, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
      return { ok: true, error: null };
    }
    return { ok: false, error: 'invalid url' };
  } catch (e) {
    logCrash('plugin-open-external', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** 渲染进程日志落盘：追加到 userData/logs/agent-<date>.log（JSON 单行）。 */
ipcMain.handle('append-log', async (_event, line) => {
  try {
    const logsDir = DIAG_DIR;
    fs.mkdirSync(logsDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const content = (typeof line === 'string' ? line : JSON.stringify(line)) + '\n';
    fs.appendFileSync(path.join(logsDir, `agent-${date}.log`), content, 'utf8');
  } catch {
    /* 忽略写盘失败 */
  }
});

/** 开机自启动：写入系统登录项（Windows 注册表 / macOS LaunchAgents / Linux .desktop）。 */
ipcMain.handle('set-auto-launch', async (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('get-auto-launch', async () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('select-directory', async () => {
  const focused = BrowserWindow.getFocusedWindow();
  const r = await dialog.showOpenDialog(focused ?? undefined, {
    properties: ['openDirectory'],
    title: '选择工作区目录',
  });
  return r.canceled || r.filePaths.length === 0 ? undefined : r.filePaths[0];
});

// 在系统文件资源管理器中打开指定目录（工作区面板「定位 / 打开目录」按钮使用）。
ipcMain.handle('harness:open-folder', async (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') return { ok: false, message: '缺少路径' };
  try {
    await shell.openPath(dirPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
});

// ============================================================
// 原生 Windows 11/10 文件夹选择器
// ============================================================
// 使用 Windows.Storage.Pickers.FolderPicker（WinRT）调起与系统文件资源管理器
// 同源的新版选择界面，而非旧版 Win32 树形对话框，也非任何 JS/HTML 实现。
// 通过 PowerShell 承载 WinRT 调用，并使用 IInitializeWithWindow 注入父窗口句柄，
// 保证弹窗模态归属到当前 Electron 窗口。非 Windows 或调用失败时回退到 Electron 原生对话框。

/** PowerShell 脚本：调起 WinRT FolderPicker 并把选中路径写到 stdout。 */
const WIN_FOLDER_PICKER_PS = `
[CmdletBinding()]
param([string]$Hwnd = '0')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32Window {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
[ComImport, Guid("3E68D4BD-7135-4D10-8019-9E82E2061902"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IInitializeWithWindow { void Initialize(IntPtr hwnd); }
'@
[Windows.Storage.Pickers.FolderPicker, Windows.Storage.Pickers, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
$fp = New-Object Windows.Storage.Pickers.FolderPicker
$fp.SuggestedStartLocation = [Windows.Storage.Pickers.PickerLocationId]::Desktop
[void]$fp.FileTypeFilter.Add('*')
$hwndVal = 0
if (-not [int64]::TryParse($Hwnd, [ref]$hwndVal) -or $hwndVal -eq 0) {
  $hwndVal = [Win32Window]::GetForegroundWindow()
}
$init = [IInitializeWithWindow]$fp
$init.Initialize([IntPtr]$hwndVal)
$folder = Await $fp.PickSingleFolderAsync() ([Windows.Storage.StorageFolder])
if ($folder -ne $null) { [Console]::Out.Write($folder.Path) }
`;

/** 把 Electron 窗口句柄转成十进制字符串传给 PowerShell。 */
function getHwndString(win) {
  try {
    const buf = win && win.getNativeWindowHandle();
    if (Buffer.isBuffer(buf)) {
      if (buf.length >= 8) return buf.readBigInt64LE(0).toString();
      if (buf.length >= 4) return buf.readUInt32LE(0).toString();
    }
  } catch {
    /* 忽略 */
  }
  return '0';
}

/** 调起 WinRT 文件夹选择器，返回路径或 undefined。 */
function pickFolderViaWinRt(hwnd) {
  return new Promise((resolve) => {
    let tmp = null;
    const cleanup = () => {
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 忽略 */
        }
      }
    };
    try {
      tmp = path.join(os.tmpdir(), `dsh-pick-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
      fs.writeFileSync(tmp, WIN_FOLDER_PICKER_PS, 'utf8');
    } catch (e) {
      console.error('[select-directory-win] 写入临时脚本失败：', e);
      resolve(undefined);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp, '-Hwnd', hwnd],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      console.error('[select-directory-win] 选择器超时（5 分钟），回退');
      finish(undefined);
    }, 300_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[select-directory-win] powershell:', msg);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      console.error('[select-directory-win] 启动 powershell 失败：', e);
      finish(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const p = out.trim();
      finish(p || undefined);
    });
  });
}

ipcMain.handle('select-directory-win', async () => {
  const focused = BrowserWindow.getFocusedWindow();
  if (process.platform === 'win32') {
    try {
      const p = await pickFolderViaWinRt(getHwndString(focused));
      if (p) return p;
    } catch (e) {
      console.error('[select-directory-win] WinRT 选择器失败，回退到 Electron 对话框：', e);
    }
  }
  const r = await dialog.showOpenDialog(focused ?? undefined, {
    properties: ['openDirectory'],
    title: '选择工作区目录',
  });
  return r.canceled || r.filePaths.length === 0 ? undefined : r.filePaths[0];
});

/** read-directory 同路径并发合并：渲染进程频繁刷新时同一目录可能被同时递归读取多次，
 * 合并为一次以降低主进程堆分配压力（历史 OOM 与其无限刷读相关）。 */
const readDirInflight = new Map();
ipcMain.handle('read-directory', async (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') return [];
  const inflight = readDirInflight.get(dirPath);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const tree = await readDirTree(dirPath);
      return [{ id: 'fs-root', name: path.basename(dirPath) || dirPath, type: 'dir', path: '', children: tree }];
    } catch (e) {
      throw new Error(`读取目录失败：${e.message || e}`);
    } finally {
      readDirInflight.delete(dirPath);
    }
  })();
  readDirInflight.set(dirPath, p);
  return p;
});

// ============================================================
// Harness 工作区（工作目录 + 权限等级）
// ============================================================
// 渲染进程在「AI 对话 (Harness)」右侧面板选择目录（WinRT 原生选择器）并设置权限，
// 经此处下发给 HarnessApp 的可变 WorkspaceState，运行时立即对所有 fs 工具生效。
// 选择会持久化到 userData/harness-workspace.json，下次启动自动恢复。

/** 工作区持久化文件路径。 */
function workspaceFilePath() {
  return path.join(app.getPath('userData'), 'harness-workspace.json');
}

/** 将当前工作区写入持久化文件（失败静默忽略）。 */
function persistWorkspace(ws) {
  try {
    fs.writeFileSync(workspaceFilePath(), JSON.stringify(ws), 'utf8');
  } catch {
    /* 忽略写盘失败 */
  }
}

/** 读取已持久化的工作区（不存在/损坏返回 null）。 */
function loadPersistedWorkspace() {
  try {
    const p = workspaceFilePath();
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && (data.workDir || data.permission)) return data;
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 校验并规整权限等级。 */
function normalizePermission(value) {
  return value === 'read' || value === 'write' || value === 'execute' ? value : 'execute';
}

ipcMain.handle('harness:set-workspace', async (_event, ws) => {
  const harnessApp = harnessAppRef;
  if (!harnessApp || typeof harnessApp.setWorkspace !== 'function') {
    return { ok: false, workspace: null, error: 'harness 未就绪' };
  }
  try {
    const next = harnessApp.setWorkspace({
      workDir: ws && ws.workDir ? String(ws.workDir).trim() : undefined,
      permission: ws && ws.permission ? normalizePermission(ws.permission) : undefined,
    });
    persistWorkspace(next);
    return { ok: true, workspace: next };
  } catch (e) {
    return { ok: false, workspace: null, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('harness:get-workspace', async () => {
  const harnessApp = harnessAppRef;
  if (!harnessApp || typeof harnessApp.getWorkspace !== 'function') {
    return { workDir: '', permission: 'execute' };
  }
  return harnessApp.getWorkspace();
});

/** 启动后恢复上次保存的工作区（GUI 模式才有意义；headless 下 harnessAppRef 同样存在）。 */
function restorePersistedWorkspace() {
  const saved = loadPersistedWorkspace();
  if (!saved) return;
  try {
    if (harnessAppRef && typeof harnessAppRef.setWorkspace === 'function') {
      harnessAppRef.setWorkspace({
        workDir: saved.workDir ? String(saved.workDir) : undefined,
        permission: saved.permission ? normalizePermission(saved.permission) : undefined,
      });
    }
  } catch {
    /* 忽略恢复失败 */
  }
}

/** 工作目录文件操作（写/读/删/列）：与 Vite /dsh-fs/op 中间件同一套路径校验规则。 */
ipcMain.handle('fs-op', async (_event, kind, workDir, relPath, content) => {
  const reply = (ok, text) => ({ ok, text });
  const rel = String(relPath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const base = String(workDir ?? '').trim().replace(/[\\/]+$/, '');
  if (!base) return reply(false, '缺少 workDir');
  // list 允许空 relPath（列工作目录根）；其余操作要求非空路径
  if (!rel && kind !== 'list') return reply(false, '缺少 relPath');
  if (rel && (/^[a-zA-Z]:/.test(rel) || rel.split('/').some((p) => p === '..' || p === ''))) {
    return reply(false, `非法路径（禁止穿越/绝对路径）：${relPath}`);
  }
  const full = rel ? path.join(base, rel) : base;
  try {
    switch (kind) {
      case 'write':
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, String(content ?? ''), 'utf8');
        return reply(true, `已写入 ${rel}（${String(content ?? '').length} 字符）`);
      case 'read':
        return reply(true, fs.readFileSync(full, 'utf8'));
      case 'delete':
        fs.unlinkSync(full);
        return reply(true, `已删除 ${rel}`);
      case 'list': {
        const names = fs.existsSync(full)
          ? fs.readdirSync(full).sort().map((n) => (fs.statSync(path.join(full, n)).isDirectory() ? `${n}/` : n))
          : [];
        return reply(true, JSON.stringify(names));
      }
      default:
        return reply(false, `未知操作：${kind}`);
    }
  } catch (e) {
    return reply(false, `文件操作失败：${e.message || e}`);
  }
});

// ============================================================
// 预热模式（安装后由安装器后台触发；也可手动 `DeepSeekAgent.exe --warmup`）
// ============================================================
// 动机：dsh web 首次冷启动要为 ~490 个包做模块解析，并在 $DSH_HOME 回填
// `profiles/node_modules` 的 ~205 条 fallback 软链（实测 +3.2s）。这份一次性开销
// 与其让用户第一次双击时干等，不如让安装器在后台先跑掉——脚本跑完即退出。
// 约束：不建窗口、不起 5183/静态服务、不抢单实例锁（绝不干扰用户随后启动的实例）。
const WARMUP_MODE = process.env.DSH_WARMUP === '1' || process.argv.includes('--warmup');

// ============================================================
// 单实例锁：双击 exe 启动多个副本时，只保留第一个进程并唤醒已有窗口。
// 没有 requestSingleInstanceLock 时，每次双击都会新起一个主进程，导致
// 「同一个 exe 起了 N 个窗口 / 起了 N 个 5183 端口 HTTP 服务」问题。
// 必须放在 module 顶部、所有 whenReady 之前，否则后续逻辑会浪费资源启动。
// ============================================================
// 预热模式不参与单实例锁：它是安装器的后台任务，绝不能把用户随后启动的实例挤掉。
const GOT_SINGLE_INSTANCE_LOCK = WARMUP_MODE ? true : app.requestSingleInstanceLock();
if (!GOT_SINGLE_INSTANCE_LOCK) {
  // 第二个/第三个副本：直接退出，让已有进程接管窗口焦点。
  app.quit();
} else {
  // 已有实例收到再次启动请求时，激活并聚焦已有窗口（不创建新窗口）。
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    const target = wins[0];
    if (!target) return;
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
  });

app.whenReady().then(async () => {
  bootMark('app-whenReady');
  // 运行时注入密钥（不进包体）
  try {
    loadEnvFile(path.join(path.dirname(process.execPath), '.env'));
    loadEnvFile(path.join(path.join(app.getPath('userData'), '.env')));
    loadEnvFile(path.join(app.getAppPath(), '.env'));
  } catch {
    /* 忽略 */
  }
  bootMark('env-loaded');

  if (WARMUP_MODE) {
    // 只跑 dsh web 的冷启动路径（模块解析 + $DSH_HOME 一次性回填），跑通即退出。
    bootMark('warmup-start');
    const finish = (why) => {
      bootMark('warmup-done', why);
      try { killDshWebChild(); } catch { /* 忽略 */ }
      try { app.exit(0); } catch { /* 忽略 */ }
    };
    startDshWebServer()
      .then(() => finish('ready'))
      .catch((e) => finish('error: ' + (e && e.message)));
    // 硬超时：预热永远不该把后台进程挂住。
    setTimeout(() => finish('timeout'), 120_000).unref();
    return;
  }

  // 启动 HTTP 服务；端口被占用时向后尝试若干端口，避免「端口冲突 → 页面打不开 → 误判闪退」。
  function startServer(port) {
    SERVER_PORT = port;
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && port < PORT + 20) {
        console.error(`[server] 端口 ${port} 被占用，尝试 ${port + 1}`);
        startServer(port + 1);
      } else {
        logCrash('server-fatal', e);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[server] listening on http://127.0.0.1:${port}/`);
      selfCheckDist();
      bootApp();
    });
  }

  async function bootApp() {
    // 不再抢先起 5283 静态服务：窗口首发的是等待页（createWindow），真正的工作台由
    // startDshWebServer 的 dsh web 子进程提供；静态托管仅作为其最终兜底。
    // 旧逻辑「先绑 5283 再 spawn dsh web」会让子进程 EADDRINUSE 换端口、窗口长期停在
    // 无后端注入的静态残页上（表现为「web boot: ModuleLoader missing」的异常界面）。

    const win = process.env.DSH_HEADLESS === '1' ? null : createWindow();

    // 超时兜底：dsh web 60s 内未就绪（缺 bin / 端口全部冲突 / boot 卡住）时，
    // 主窗口维持等待页（旧自研 SPA 兜底已移除，仅 dsh-web-ui 一种界面）。
    // 若 dsh web 之后才就绪，captureDshWebToken 仍会把窗口跳到真实工作台。
    if (win) {
      const fallbackTimer = setTimeout(() => {
        try {
          if (!workbenchAuthUrl && win && !win.isDestroyed()) {
            // 旧自研 SPA（5183）已移除，主窗口只加载官方 dsh-web-ui；
            // dsh web 即便晚于 60s 就绪，captureDshWebToken 仍会把窗口跳到真实工作台，
            // 这里不再回退本地 SPA，仅保持等待页。
            console.error('[web-server] dsh web 60s 未就绪；旧本地 SPA 已移除，维持等待页');
          }
        } catch {
          /* 窗口已销毁等竞态：忽略 */
        }
      }, 60_000);
      fallbackTimer.unref();
    }

    // 预加载插件宿主：发现/启用状态就绪（不阻塞窗口创建，IPC 为惰性加载）。
    // 失败仅记录，不影响主流程（无插件时不报错）。
    ensurePluginHost().then(async (host) => {
      bootMark('plugin-host-ready', host && typeof host.list === 'function' ? `plugins=${host.list().length}` : 'no-host');
      if (host && typeof host.list === 'function') {
        const discovered = host.list();
        console.error(`[plugin-host] 已发现 ${discovered.length} 个插件`);
        // 展示模式：对启用插件做（或 staged）激活，解析能力摘要供 UI 展示。
        // Cordis 运行时未链接时（沙箱 / 未 pnpm install）降级为 staged，不报错。
        for (const p of discovered) {
          if (!p.enabled) continue;
          try {
            const rec = await host.activate(p);
            console.error(`[plugin-host] 激活 ${p.name} -> ${rec.status}`);
          } catch (e) {
            console.error(`[plugin-host] 激活 ${p.name} 失败:`, e && e.message);
          }
        }
      }
    }).catch(console.error);

    // 初始化 Harness（ESM 动态导入）
    try {
      const harnessPath = path.join(__dirname, 'harness-dist', 'app.js');
      // Windows 上动态 import() 必须用 file:// URL，直接传 C:\... 会被解析为 scheme 'c:' 而报错。
      const harnessModule = await import(pathToFileURL(harnessPath).href);
      bootMark('harness-imported');
      const { HarnessApp, loadHarnessConfig } = harnessModule;

      // 加载配置
      const config = loadHarnessConfig();
      // 如果有运行时 API Key，优先使用
      if (runtimeApiKey) {
        config.apiKey = runtimeApiKey;
      } else if (process.env.DEEPSEEK_API_KEY) {
        config.apiKey = process.env.DEEPSEEK_API_KEY;
      }

      // 创建 Harness 应用
      const harnessApp = new HarnessApp(config);
      await harnessApp.start();
      bootMark('harness-started');
      harnessAppRef = harnessApp;
      harnessReady = true;
      // 恢复上次保存的工作区（目录 + 权限）
      restorePersistedWorkspace();

      // 创建 IPC 桥接（无头模式跳过窗口与桥接，仅保留 harness 供 /healthz 探测）
      if (win) {
        const { HarnessIpcBridge } = harnessModule;
        const bridge = new HarnessIpcBridge(harnessApp, win, ipcMain);
        win.on('closed', () => {
          bridge.dispose();
          // 正常退出时 before-quit 已做过全量清理；这里兜底「仅主窗口被销毁」的场景。
          shutdownAllServices();
        });
      } else {
        process.on('SIGTERM', () => {
          shutdownAllServices();
        });
      }
    } catch (e) {
      console.error('[harness] 初始化失败:', e);
      harnessError = e;
    }
  }

  // 顺序很重要（2026-09-11 启动提速）：**先**拉起 dsh web，再起原生主后端（5183）。
  // 用户看到界面所需的全部时间都在 dsh web 冷启动上（实测 4.9s / 总 6.4s），而
  // 5183 监听只要几十毫秒且只在 dsh web 失败时兜底；先起它等于让关键路径白等一轮
  // 事件循环。反过来先 spawn dsh web，主后端在子进程初始化的同时并行就绪。
  startDshWebServer().then((ws) => { webServer = ws; }).catch((e) => {
    console.error('[web-server] 启动异常，回退静态托管：', e && (e.stack || e.message));
    startStaticWebServer().then((ws) => { webServer = ws; }).catch((e2) => {
      console.error('[web-server] 静态回退也失败：', e2);
    });
  });
  // 原生主后端（5183）：供窗口 /zhipu 代理与静态兜底页面使用。
  startServer(PORT);
}).catch((e) => {
  console.error('[app] whenReady 失败:', e);
});

// 仅在明确退出（用户关闭 / 系统关机）时退出；渲染进程崩溃走自动重载恢复，不应触发整 app 退出。
let isQuiting = false;

/**
 * 关闭本进程拥有的全部服务：dsh web 子进程树 + 主后端(5183)/工作台(5283)监听 + harness。
 * 背景：旧实现退出时不杀 dsh web 子进程，exe 关掉后工作台端口仍存活可访问。
 * 只操作自己 spawn / listen 的资源，绝不按端口反查进程去杀（避免误杀外部占用者）。
 */
function shutdownAllServices() {
  if (servicesShutdown) return;
  servicesShutdown = true;
  try { killDshWebChild(); } catch (e) { logCrash('shutdown-kill-dsh-web', e); }
  try { if (webServer) { webServer.close(); webServer = null; } } catch (e) { logCrash('shutdown-web-server', e); }
  try { server.close(); } catch (e) { logCrash('shutdown-main-server', e); }
  try {
    if (!harnessStopped && harnessAppRef && typeof harnessAppRef.stop === 'function') {
      harnessStopped = true;
      harnessAppRef.stop().catch((e) => logCrash('shutdown-harness', e));
    }
  } catch (e) { logCrash('shutdown-harness-sync', e); }
}

app.on('before-quit', () => {
  isQuiting = true;
  // 先做服务级清理（杀子进程树 + 关监听），再放行所有窗口的关闭，
  // 否则退出流程被无限 close 拦截器卡住。
  shutdownAllServices();
  try {
    for (const w of BrowserWindow.getAllWindows()) w.__allowClose = true;
  } catch {
    /* 忽略 */
  }
  // 退出看门狗：观测到 before-quit 之后 Electron 的关窗/quit 序列偶发停摆
  // （主进程无窗口仍存活）。服务资源在上面的 shutdownAllServices 已全部释放，
  // 5s 后仍未自然退出则强制结束进程，杜绝残留。
  setTimeout(() => {
    try { logCrash('quit-watchdog', 'quit 序列停摆，5s 看门狗强制 app.exit(0)'); } catch { /* 忽略 */ }
    try { app.exit(0); } catch { /* 忽略 */ }
  }, 5000);
  logCrash('before-quit', '应用准备退出');
});
app.on('quit', (_e, code) => {
  logCrash('quit', `进程退出 code=${code}`);
});
app.on('window-all-closed', () => {
  if (isQuiting) {
    // 用户主动退出：真正退出。非 macOS 下 app.quit() 已在 before-quit 中调用。
    return;
  }
  if (process.platform !== 'darwin') {
    // 非用户主动退出（例如渲染进程崩溃把窗口一起带走了）：尽量保活，重建窗口而非退出。
    if (mainWindow === null || mainWindow.isDestroyed()) {
      console.error('[app] 所有窗口已关闭但非主动退出，重建窗口以避免整客户端闪退');
      try {
        createWindow();
      } catch (e) {
        logCrash('recreate-window-failed', e);
      }
    }
  }
});

// 子进程（如 WinRT 文件夹选择器的 powershell）异常退出也记录，便于排查。
app.on('child-process-gone', (_event, child) => {
  logCrash('child-process-gone', {
    type: child?.type,
    reason: child?.reason,
    serviceName: child?.serviceName,
    exitCode: child?.exitCode,
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 系统休眠/恢复检测：通知渲染进程，使其能自动恢复中断的任务
powerMonitor.on('suspend', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('power-suspend');
  }
});
powerMonitor.on('resume', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('power-resume');
  }
});

} // 关闭「单实例锁获取成功」else 块；未拿到锁的副本在顶部 app.quit() 后直接退出。
