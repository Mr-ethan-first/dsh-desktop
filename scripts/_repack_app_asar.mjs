/**
 * 同步主进程修复源码到部署态 DeepSeekAgent（实际加载源 = app.asar.unpacked）。
 *
 * 实测本构建（2026-09-11 起的包）：app.asar 内 `electron/` 条目数为 0，
 * 整个 electron/** 都在 app.asar.unpacked/ 下，Electron 实际从
 * app.asar.unpacked 加载主进程代码。因此修复只需落到 app.asar.unpacked
 * （重打包 app.asar 内副本无效，因为不会被加载）。
 *
 * 同步文件：
 *   - electron/main.cjs                         (setWindowOpenHandler 等修复)
 *   - electron/plugin-host/dsh-web-launcher.cjs (prepareDshHome 合并市场插件修复)
 *
 * 部署前对两个目标文件各做时间戳备份（.bak-<ts>），再覆盖并校验。
 *
 * Usage: node scripts/_repack_app_asar.mjs [--deploy]
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

const UNPACKED = 'D:/DeepSeekAgent/resources/app.asar.unpacked'
const PATCHED_MAIN = 'D:/WorkSpace/deepseek-harness-master/apps/agent-client/electron/main.cjs'
const PATCHED_LAUNCHER = 'D:/WorkSpace/deepseek-harness-master/apps/agent-client/electron/plugin-host/dsh-web-launcher.cjs'
const DEPLOY = process.argv.includes('--deploy')

const log = (...a) => console.log('[sync]', ...a)

// 0) preconditions
for (const f of [PATCHED_MAIN, PATCHED_LAUNCHER]) {
  if (!existsSync(f)) { console.error('missing', f); process.exit(1) }
}
// sanity: 两个源文件必须各自携带对应修复
const mainText = readFileSync(PATCHED_MAIN, 'utf8')
if (!mainText.includes('setWindowOpenHandler')) { console.error('patched main.cjs lacks setWindowOpenHandler'); process.exit(1) }
const launcherText = readFileSync(PATCHED_LAUNCHER, 'utf8')
if (!launcherText.includes('isBaseOrVendored')) { console.error('patched launcher lacks merge fix (isBaseOrVendored)'); process.exit(1) }
log('patched sources OK (main.cjs + launcher.cjs)')

const mainTarget = join(UNPACKED, 'electron/main.cjs')
const launcherTarget = join(UNPACKED, 'electron/plugin-host/dsh-web-launcher.cjs')
if (!existsSync(mainTarget) || !existsSync(launcherTarget)) {
  console.error('deploy target missing in unpacked; abort', mainTarget, launcherTarget)
  process.exit(1)
}

if (!DEPLOY) {
  log('DRY RUN — targets exist, sources carry fixes. Pass --deploy to publish.')
  process.exit(0)
}

// 1) backup current unpacked targets
const ts = Date.now()
for (const t of [mainTarget, launcherTarget]) {
  renameSync(t, `${t}.bak-${ts}`)
}
log('backed up unpacked targets (.bak-' + ts + ')')

// 2) sync patched sources → actual load source
cpSync(PATCHED_MAIN, mainTarget)
cpSync(PATCHED_LAUNCHER, launcherTarget)

// 3) verify
const vMain = readFileSync(mainTarget, 'utf8')
const vLauncher = readFileSync(launcherTarget, 'utf8')
if (!vMain.includes('setWindowOpenHandler')) { console.error('VERIFY FAIL: unpacked main.cjs lacks fix'); process.exit(2) }
if (!vLauncher.includes('isBaseOrVendored')) { console.error('VERIFY FAIL: unpacked launcher lacks fix'); process.exit(2) }
log('verified — unpacked main.cjs + launcher.cjs both carry fixes')
log('deployed (actual load source synced)')
