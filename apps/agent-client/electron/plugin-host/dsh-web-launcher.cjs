// 插件工作台：拉起官方 `dsh web` 服务端（纯 Node，零 electron 依赖，可被 vitest 单测）。
//
// 关键契约（选项一，已对照上游源码修正）：
//   上游 `dsh` 并**不**读取任何「扩展目录」环境变量。它的插件（bundle）发现机制是：
//     1. 通过 `DSH_HOME`（@deepseek-ai/dsh-home-paths）定位 Harness 主目录；
//     2. 读取 `$DSH_HOME/profiles/<name>/package.json` 的 `dsh.profile.bundles`
//        （一个 npm 包名数组），以及每个包的 `dsh.bundle.patch`；
//     3. 按 Node 的 node_modules 解析顺序找到这些包（先安装根，再 profile 目录）。
//   `dsh web` 等价于 profile `web`（上游 web-app 的 cordis.patch.yml / webCommand
//   名为 `dsh --profile web`）。原 `web` profile 仅含 `dsh-base` + `dsh-web-app`，
//   不含社区插件。
//
//   因此「强制让 dsh web 挂载仓库内 vendored 的 packages/extensions」的正确做法是：
//     在 $DSH_HOME/profiles/web 里把社区插件写进 dsh.profile.bundles，并把每个插件
//     软链（junction）到该 profile 的 node_modules，再让子进程继承 DSH_HOME。
//   原先设想的 DSH_WEB_EXTENSIONS_DIR 在上游不存在，已废弃（见 dsh-web-launcher.spec.ts
//   的源码审计用例）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");

/** `web` profile 默认就有的基础 bundle（上游 PROFILE_TEMPLATES.web.bundles）。 */
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/**
 * 已知与当前 dsh 版本不兼容、**绝不能加载**的插件（按包名精确匹配，写 scoped 全名）。
 * prepareDshHome 在合并 profile 清单时会把它们从 bundles 与 dependencies 中剔除，
 * 避免「从插件市场装了就炸」的问题重复发生（插件文件留在磁盘，只是不再被挂载）。
 *
 * 条目：
 *   - `@linxin666/dsh-remote-web-ui`：其竖屏适配层（`body.dsh-remote-portrait`）的 CSS
 *     选择器按官方 **0.1.2-alpha.1** 的 CSS-Modules 类名后缀写就；在 **0.1.5-rc.2** 上
 *     选择器失配，会把工作台主内容（含 composer 输入框）折叠隐藏 → 手机端**白屏**
 *     （只剩左上角悬浮按钮）。实测：关掉该适配层后同一手机视口渲染完全正常。
 *     注意：其配置项 `enabled:false` 是 fail-closed（会拦掉一切非回环请求），不能用它
 *     关闭；也**没有**单独的适配层开关。故只能整包不加载。
 *     若上游后续修好该失配，删除本条目即可恢复。
 */
const BLOCKED_PLUGINS = new Set(['@linxin666/dsh-remote-web-ui']);
/** 判定插件是否被黑名单拦截。 */
const isBlockedPlugin = (n) => typeof n === 'string' && BLOCKED_PLUGINS.has(n);

/**
 * 读取 extensionsDir 下的 package.json（受限递归，depth<=3，跳过 node_modules），
 * 返回 { name, dir } 列表（即「我们想让 dsh web 挂载的社区插件」）。
 *
 * 递归原因：部分插件是 monorepo/嵌套结构，真正的 dsh bundle 不在 extensionsDir
 * 的一级子目录。例如 dsh-browser 的 dsh 插件位于
 * `dsh-browser-0.1.3/packages/browser/bridge-browser`，其 package.json 才声明
 * `dsh.bundle`。一级扫描会漏掉它，故向下有限递归。
 *
 * 仅当 package.json 声明了 `dsh.bundle` 才视为 profile bundle。packages/extensions
 * 下部分扩展（dsh-cordis-client-runner 等）是辅助 cordis 插件，由应用内 plugin
 * host 加载，不是独立 profile bundle；加入它们会让 loadProfile 抛
 * "declares no dsh.bundle"。
 *
 * @param {string} extensionsDir
 * @param {number} [depth]
 * @param {Set<string>} [seen] 已发现插件名，防重复挂载
 * @returns {{name:string,dir:string}[]}
 */
function readCommunityPlugins(extensionsDir, depth = 0, seen = new Set()) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(extensionsDir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    if (!e.isDirectory()) continue;
    const dir = path.join(extensionsDir, e.name);
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
      catch { pkg = null; }
      if (
        pkg && typeof pkg.name === 'string' && pkg.name.length > 0 &&
        pkg.dsh && pkg.dsh.bundle && !seen.has(pkg.name)
      ) {
        seen.add(pkg.name);
        out.push({ name: pkg.name, dir });
        continue; // 已发现 bundle，不再深入其子树
      }
    }
    // 向下有限递归，定位嵌套的 dsh bundle（如 monorepo 插件）
    if (depth < 3) out.push(...readCommunityPlugins(dir, depth + 1, seen));
  }
  return out;
}

/**
 * 让 link 成为指向 target 的 junction/软链（已指向则跳过，指向别处或普通目录则替换）。
 * Windows 用 'junction'（目录），POSIX 用 'dir'。
 * @param {string} link
 * @param {string} target
 */
function ensureJunction(link, target) {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      if (fs.readlinkSync(link) === target) return;
      fs.unlinkSync(link);
    } else if (st.isDirectory()) {
      fs.rmSync(link, { recursive: true, force: true });
    } else {
      fs.unlinkSync(link);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, os.platform() === 'win32' ? 'junction' : 'dir');
}

/** 读取 package.json（失败返回 null）。 */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 为一棵社区插件目录树建立「共享解析回退目录」 `<extensionsDir>/node_modules`。
 *
 * 背景（2026-09-11 安装包瘦身）：
 * 每个插件包内含自己的 `node_modules`，里面**全部是指向运行时 node_modules 的
 * junction**（`@deepseek-ai`、`cordis`、`react`、`ws` ……）。NSIS 的 `File /r`
 * 会把 junction 展开成真实目录，而 `@deepseek-ai` 一棵树就有约 85MB —— 每插件一份、
 * 且在 `resources/dsh-runtime` 与 `resources/packages` 两条路径各展开一次，
 * 使安装包载荷从 ~620MB 虚增到 ~1.57GB。
 *
 * 这些 junction 只为 Node 的向上解析服务，路径无关紧要：Node 解析 ESM 时对插件取
 * realpath（`preserveSymlinks=false`），因此只要在插件目录的**某个祖先**放一份等价
 * 的 `node_modules` 即可。本函数在 `<extensionsDir>/node_modules` 建这一份共享回退：
 *   1) 运行时 node_modules 的每个顶层条目（含 `@scope` 作用域目录）建 junction；
 *   2) 插件 dependencies/peerDependencies 里「运行时顶层没有、但 `@deepseek-ai/<name>`
 *      有」的裸名（如 `cordis`、`schemastery`、`cosmokit`）单独建 junction。
 * 于是插件包自身的 `node_modules` 可以整体不进安装包，由本函数在首次启动时重建。
 *
 * 幂等且只增不减：已存在的正确链接跳过；指向别处或普通目录则替换（同 ensureJunction）。
 *
 * @param {object} [opts]
 * @param {string} [opts.extensionsDir] 社区插件目录
 * @param {string} [opts.runtimeModulesDir] 运行时 node_modules（<resources>/dsh-runtime/node_modules）
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {number} 本次实际建立/修复的链接数
 */
function ensureExtensionsModuleFallback({ extensionsDir, runtimeModulesDir, onLog } = {}) {
  if (!extensionsDir || !runtimeModulesDir) {
    if (onLog) onLog('[ext-fallback] 跳过：缺 extensionsDir 或 runtimeModulesDir（插件依赖解析回退无法建立）');
    return 0;
  }
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if (!exists(extensionsDir) || !exists(runtimeModulesDir)) {
    if (onLog) {
      onLog('[ext-fallback] 跳过：目录不存在 extensionsDir=' + extensionsDir + ' runtimeModulesDir=' + runtimeModulesDir);
    }
    return 0;
  }

  /** name -> 目标绝对路径 */
  const targets = new Map();
  let top = [];
  try { top = fs.readdirSync(runtimeModulesDir); } catch (e) {
    if (onLog) onLog('[ext-fallback] 读取运行时 node_modules 失败: ' + (e && e.message));
    return 0;
  }
  for (const name of top) {
    // `.bin` / 隐藏目录（如 `.package-lock.json`、`.pnpm`）不参与解析回退
    if (name.startsWith('.')) continue;
    targets.set(name, path.join(runtimeModulesDir, name));
  }
  // 裸名兜底：`cordis` / `schemastery` / `cosmokit` 这类「只在 @deepseek-ai 作用域下
  // 存在」的包，历史上是以「真实目录副本」放在插件自己的 node_modules 里的。
  // 那些副本已随插件 node_modules 一起从安装包剔除，这里按需补回裸名链接。
  //   2a) 插件显式声明的 dependent/peer 名（最保守，优先）
  for (const p of readCommunityPlugins(extensionsDir)) {
    const manifest = readJson(path.join(p.dir, 'package.json'));
    if (!manifest) continue;
    const names = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.peerDependencies || {}),
    ];
    for (const name of names) {
      if (name.startsWith('@') || targets.has(name)) continue;
      const scoped = path.join(runtimeModulesDir, '@deepseek-ai', name);
      if (exists(scoped)) targets.set(name, scoped);
    }
  }
  //   2b) `@deepseek-ai/*` 中「裸名尚未被运行时顶层覆盖」的包（如 cosmokit 未被任何
  //       插件显式声明，却是 schemastery 的传递依赖）。补齐为裸名，语义与原真实副本一致。
  const scopeDir = path.join(runtimeModulesDir, '@deepseek-ai');
  try {
    for (const name of fs.readdirSync(scopeDir)) {
      if (name.startsWith('.') || targets.has(name)) continue;
      const dir = path.join(scopeDir, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      targets.set(name, dir);
    }
  } catch { /* 无 @deepseek-ai 作用域时忽略 */ }

  const mirrorDir = path.join(extensionsDir, 'node_modules');
  try { fs.mkdirSync(mirrorDir, { recursive: true }); } catch (e) {
    if (onLog) onLog('[ext-fallback] 创建回退目录失败 ' + mirrorDir + ': ' + (e && e.message));
    return 0;
  }
  let created = 0;
  let failed = 0;
  for (const [name, target] of targets) {
    try {
      ensureJunction(path.join(mirrorDir, name), target);
      created++;
    } catch (e) {
      failed++;
      if (onLog) onLog('[ext-fallback] link failed ' + name + ': ' + (e && e.message));
    }
  }
  // 建完自检：插件依赖解析完全依赖这份回退，缺一个都可能让 dsh web boot 抛错退出
  // （现象=exe 卡在「正在启动 DSH Web 工作台…」无限重试）。这里只读核对、只报不修。
  const missing = [...targets.keys()].filter((n) => !exists(path.join(mirrorDir, n)));
  if (onLog) {
    onLog('[ext-fallback] 回退就绪 mirror=' + mirrorDir + ' targets=' + targets.size +
      ' linked=' + created + ' failed=' + failed + ' missing=' + missing.length);
    if (missing.length) {
      onLog('[ext-fallback] 仍缺失（插件会解析失败）: ' + missing.slice(0, 10).join(', ') +
        (missing.length > 10 ? ' …' : ''));
    }
  }
  return created;
}

/**
 * 准备 $DSH_HOME/profiles/<profileName>，使 `dsh web` 真正挂载仓库内 vendored 的社区插件。
 * 幂等：manifest 内容未变则不重写（避免每次启动都改 mtime / 使下游缓存失效），
 * 软链只在缺失或指向错误时修复。
 * @param {object} opts
 * @param {string} opts.extensionsDir 社区插件目录（packages/extensions）
 * @param {string} opts.dshHome 目标 DSH_HOME（我们将在此写入 profiles/web）
 * @param {string} [opts.profileName] 默认 'web'
 * @param {string} [opts.runtimeModulesDir] 运行时 node_modules（建立插件共享解析回退）
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {string} dshHome
 */
function prepareDshHome({ extensionsDir, dshHome, profileName = 'web', runtimeModulesDir, onLog } = {}) {
  if (!dshHome) throw new Error('prepareDshHome: dshHome is required');
  // 插件共享解析回退：必须在 dsh web 解析 `web` profile 之前就位。
  if (extensionsDir && runtimeModulesDir) {
    try { ensureExtensionsModuleFallback({ extensionsDir, runtimeModulesDir, onLog }); }
    catch (e) { if (onLog) onLog('[web-server] ensureExtensionsModuleFallback failed: ' + (e && e.message)); }
  }
  const profileDir = path.join(dshHome, 'profiles', profileName);
  fs.mkdirSync(profileDir, { recursive: true });
  const plugins = (extensionsDir ? readCommunityPlugins(extensionsDir) : [])
    .filter((p) => !isBlockedPlugin(p.name));
  const vendoredNames = plugins.map((p) => p.name);

  // 关键修复：保留「市场（dsh-market）在运行期安装到本 profile 的社区插件」。
  // 旧实现每次启动都用 readCommunityPlugins(extensionsDir) 重建整份清单，而市场安装
  // 的插件落在 profile 自身的 node_modules、并不在 vendored 的 extensionsDir 里，于是
  // 被从 dsh.profile.bundles / dependencies 中抹掉 —— 插件文件虽仍在磁盘，却不再被加载，
  // 表现即「用插件市场装的插件重启后消失」。这里读取已有清单，凡既不属 in-box 基础
  // bundle、也不属 vendored 社区插件的条目（即市场安装项）一律保留，再补齐 vendored。
  const manifestPath = path.join(profileDir, 'package.json');
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 首次 */ }
  const existingBundles = (
    existing && existing.dsh && existing.dsh.profile && Array.isArray(existing.dsh.profile.bundles)
      ? existing.dsh.profile.bundles
      : []
  ).filter((n) => typeof n === 'string');
  const existingDeps = (
    existing && existing.dependencies && typeof existing.dependencies === 'object'
      ? existing.dependencies
      : {}
  );
  const isBaseOrVendored = (n) => BASE_BUNDLES.includes(n) || vendoredNames.includes(n);
  // 黑名单插件：无论来自 base / vendored 还是市场安装记录，一律不挂载。
  const blockedHit = existingBundles.filter(isBlockedPlugin);
  const dynamicBundles = existingBundles.filter((n) => !isBaseOrVendored(n) && !isBlockedPlugin(n));

  const bundles = BASE_BUNDLES.filter((n) => !isBlockedPlugin(n));
  for (const n of vendoredNames) if (!bundles.includes(n)) bundles.push(n);
  for (const n of dynamicBundles) if (!bundles.includes(n)) bundles.push(n);

  // 依赖：保留市场安装记录的版本 spec（与 dsh-market 的 readInstalled 对齐，卸载时由其自行清理），
  // vendored 插件仍按原逻辑不写入 dependencies（经由 profile node_modules 软链解析）。
  const dependencies = { ...existingDeps };
  for (const n of Object.keys(dependencies)) if (isBlockedPlugin(n)) delete dependencies[n];
  if (blockedHit.length && onLog) {
    onLog('[web-server] 已屏蔽不兼容插件（不写入 profile，不加载）: ' + [...new Set(blockedHit)].join(', '));
  }

  const manifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles, patchReload: 'live' } },
  };
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  // 幂等：内容一致就不写盘（重写会刷新 mtime，可能让 dsh 侧的回填/缓存判定失效）。
  let current = null;
  try { current = fs.readFileSync(manifestPath, 'utf8'); } catch { /* 首次 */ }
  if (current !== serialized) fs.writeFileSync(manifestPath, serialized);
  if (extensionsDir) {
    const modulesDir = path.join(profileDir, 'node_modules');
    for (const p of plugins) {
      ensureJunction(path.join(modulesDir, p.name), p.dir);
    }
  }
  return dshHome;
}

/**
 * 构造 dsh web 子进程的环境变量：把 DSH_HOME 指向我们准备好的主目录。
 * 不修改 baseEnv（返回新对象）。
 * @param {object} [opts]
 * @param {string} [opts.dshHome]
 * @param {NodeJS.ProcessEnv} [opts.baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function buildDshWebEnv({ dshHome, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  if (dshHome) env.DSH_HOME = dshHome;
  // 不注入任何 provider 的 base URL / api key：保留 deepseek-harness 原生默认
  // （deepseek-official provider 走 DEEPSEEK_API_KEY 环境变量 + 官方端点），
  // 用户需在应用内配置自己的 DeepSeek API Key。
  // 关键：从 WorkBuddy 等环境继承的 NODE_OPTIONS 会注入 safe-delete shim，
  // 该 shim 会拦截 dsh-atomic-write 对 *.lock 的 fs.rm，导致启动时死锁超时。
  // dsh web 后端不应被外部 Node shim 污染，故显式清除。
  delete env.NODE_OPTIONS;
  // 启动提速历史记录（2026-09-18 实测推翻旧结论，勿再启用 NODE_COMPILE_CACHE）：
  // 2026-09-17 曾在此注入 NODE_COMPILE_CACHE=<DSH_HOME>/compile-cache 并声称"热启动 -2s"。
  // 2026-09-18 用部署态 node.exe(v24.16.0) 做 A/B 实测（各 3 轮，交替端口）：
  //   不开缓存：5835 / 6198 / 5592 ms
  //   开缓存  ：6446 / 7066 / 6759 ms   ← 反而慢 ~800ms，且 <DSH_HOME>/compile-cache
  //                                      下**始终 0 个文件**（仅有两个空的版本子目录）。
  // 根因：Node 的 NODE_COMPILE_CACHE 只覆盖 **ESM loader** 加载的模块与 CJS 入口模块；
  // dsh web 的启动开销几乎全部来自数百次 CJS require()（yaml / @opentelemetry / semver
  // 等），这些不写入该缓存。开启后只是多了一层无收益的目录探测开销。
  // 结论：不再注入。真正的冷启动瓶颈见下方 warmup 与 _prewarm 说明。
  delete env.NODE_COMPILE_CACHE;
  return env;
}

/**
 * 返回候选列表里第一个真实存在的可执行文件路径；都不存在返回 null。
 * @param {string[]} candidates
 * @returns {string|null}
 */
function resolveDshBin(candidates) {
  for (const c of candidates || []) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 解析 dsh CLI 的启动方式，返回 { bin, nodeArgs } 或 null。
 *
 * 优先级：
 * 1. `node_modules/.bin/dsh`（真正安装过 CLI 的情况）
 * 2. 已构建的 CLI 入口 `<cliDir>/lib/bin.js` —— 直接用 node 跑，无需 tsx
 * 3. CLI 源码 `<cliDir>/src/bin.ts` —— 需 `node --import tsx/esm`
 *
 * 说明：本仓库是 pnpm workspace，root `node_modules/.bin/dsh` 并不存在
 * （`@deepseek-ai/dsh` 是 workspace 包 `apps/cli`，未做 root bin 链接），
 * 因此必须支持 2/3 两种「node + 入口文件」的启动方式，否则 dsh web 永远起不来。
 *
 * @param {object} opts
 * @param {string} opts.cliDir dsh CLI 包目录（如 <repo>/apps/cli）
 * @param {string[]} [opts.extraBins] 额外候选可执行文件路径
 * @param {{existsSync:(p:string)=>boolean}} [opts.fs]
 * @returns {{bin:string, nodeArgs:string[]}|null}
 */
function resolveDshLaunch({ cliDir, extraBins, fs: fsImpl = fs } = {}) {
  const exists = (p) => { try { return fsImpl.existsSync(p); } catch { return false; } };
  for (const p of extraBins || []) {
    if (p && exists(p)) return { bin: p, nodeArgs: [] };
  }
  if (cliDir) {
    const built = path.join(cliDir, 'lib', 'bin.js');
    if (exists(built)) return { bin: built, nodeArgs: [] };
    const src = path.join(cliDir, 'src', 'bin.ts');
    if (exists(src)) return { bin: src, nodeArgs: ['--import', 'tsx/esm'] };
  }
  return null;
}

/**
 * 拉起 dsh web 子进程。
 * 若同时传入 dshHome 与 extensionsDir，会先 prepareDshHome（注入社区插件到 web profile）。
 * @param {object} opts
 * @param {string} opts.bin 可执行文件（dsh 本体；测试可传 node + 自定义 args 模拟）
 * @param {number} [opts.port] 监听端口
 * @param {string} [opts.dshHome] 目标 DSH_HOME（会被写入 env 并用于准备 profile）
 * @param {string} [opts.extensionsDir] 社区插件目录
 * @param {string} [opts.runtimeModulesDir] 运行时 node_modules（建立插件共享解析回退；
 *        安装包剔除了插件自身的 node_modules，漏传此项会让所有社区插件解析依赖失败）
 * @param {string} [opts.profileName] 默认 'web'
 * @param {NodeJS.ProcessEnv} [opts.baseEnv] 继承的环境（默认 process.env）
 * @param {string[]} [opts.args] 自定义启动参数（默认 ['web','--port',String(port),'--no-open']）
 * @param {object} [opts.childProcess] 注入 child_process（默认真实，便于测试）
 * @param {(msg:string)=>void} [opts.onLog] 日志回调
 * @param {string[]} [opts.nodeArgs] 传给 node 的预置参数（如 ['--import','tsx/esm']），置于入口文件之前
 * @param {string} [opts.runtime] 运行入口的可执行文件（默认 process.execPath，即当前 node）
 * @returns {import('node:child_process').ChildProcess|null}
 */
function spawnDshWeb({ bin, port, dshHome, extensionsDir, profileName = 'web', runtimeModulesDir, baseEnv = process.env, args, childProcess: cp = childProcess, onLog, nodeArgs = [], runtime = process.execPath } = {}) {
  if (!bin) return null;
  const home = dshHome || baseEnv.DSH_HOME;
  if (home && extensionsDir) {
    // runtimeModulesDir 必须一并转发：安装包按设计剔除了插件自身的 node_modules（NSIS
    // 的 File /r 会把 junction 展开成真实目录，载荷虚增约 750MB），插件依赖解析只剩
    // `<extensionsDir>/node_modules` 这份共享回退。漏传 = 回退永不建立 = 每个 vendored
    // 社区插件 import 依赖失败（Cannot find package 'ws' / '@deepseek-ai/schemastery'）
    // = dsh web boot 抛 AggregateError 退出 = exe 卡在「正在启动 DSH Web 工作台…」
    // 无限重试。2026-09-15 实测回归，勿删。
    try { prepareDshHome({ extensionsDir, dshHome: home, profileName, runtimeModulesDir, onLog }); }
    catch (e) { if (onLog) onLog('[web-server] prepareDshHome failed: ' + (e && e.message)); }
    // 建完立即自检：缺失必须显式报错，而不是留给子进程去 boot 失败（否则用户只看到转圈）。
    // 只在回退确实不存在时告警：开发态/部署树里插件自带的 node_modules 仍在磁盘，镜像
    // 即便是空的也能解析，不该刷无意义的警告。
    if (onLog) {
      const mirror = path.join(extensionsDir, 'node_modules');
      if (!fs.existsSync(mirror)) {
        onLog('[web-server] 警告：插件共享解析回退不存在 ' + mirror +
          '（runtimeModulesDir=' + (runtimeModulesDir || '<未提供>') +
          '）社区插件将无法解析依赖，dsh web 会 boot 失败并卡在启动页');
      }
    }
  }
  const env = buildDshWebEnv({ dshHome: home, baseEnv });
  // --no-open：exe 的展示端就是 Electron 主窗口，dsh web 不再自动拉起系统浏览器。
  const finalArgs = Array.isArray(args) ? args : ['web', '--port', String(port), '--no-open'];
  // bin 可能是「可执行命令」，也可能是「JS/TS 入口文件」。后者需要用 node 拉起，
  // 并把 nodeArgs（如 --import tsx/esm）放在入口文件之前。
  const spawnFile = runtime;
  const spawnArgs = [...nodeArgs, bin, ...finalArgs];
  try {
    const child = cp.spawn(spawnFile, spawnArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    if (onLog) {
      if (child.stdout) child.stdout.on('data', (d) => onLog('[dsh-web] ' + d.toString().trim()));
      if (child.stderr) child.stderr.on('data', (d) => onLog('[dsh-web] ' + d.toString().trim()));
      child.on('error', (e) => onLog('[dsh-web] spawn error: ' + (e && e.message)));
      child.on('exit', (code) => onLog('[dsh-web] exit code=' + code));
    }
    return child;
  } catch (e) {
    if (onLog) onLog('[web-server] spawn dsh web failed: ' + (e && e.message));
    return null;
  }
}

module.exports = { BASE_BUNDLES, readCommunityPlugins, ensureJunction, ensureExtensionsModuleFallback, prepareDshHome, buildDshWebEnv, resolveDshBin, resolveDshLaunch, spawnDshWeb };
