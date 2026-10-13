// Overwrite-deploy the packed app into D:\DeepSeekAgent WITHOUT deleting.
//
// Why: `fs.rm(resources/app.asar.unpacked, { recursive: true })` stalls for
// 20+ minutes on this machine (Lenovo/火绒 real-time scan holds locks on a few
// files). Overwriting in place needs no exclusive lock and finishes in seconds.
// Stale files that the delete could not remove stay behind (they are a handful
// of unchanged artifacts), which is strictly better than never deploying.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve('D:/WorkSpace/deepseek-harness-master/apps/agent-client')
const STAGE = join(APP_ROOT, '_asar_stage')
const RES = 'D:/DeepSeekAgent/resources'

if (!existsSync(join(STAGE, 'electron/main.cjs'))) {
  console.error('stage 不完整，缺少 electron/main.cjs：', STAGE)
  process.exit(1)
}

// 1) app.asar
copyFileSync(join(APP_ROOT, 'app.asar'), join(RES, 'app.asar'))
console.log('app.asar ->', join(RES, 'app.asar'))

// 2) unpacked electron/ (overwrite)
const unpackedElectron = join(RES, 'app.asar.unpacked/electron')
mkdirSync(unpackedElectron, { recursive: true })
cpSync(join(STAGE, 'electron'), unpackedElectron, { recursive: true, force: true })
console.log('electron/ ->', unpackedElectron)

// 3) resources/app/apps/web/dist (code requires APP_ROOT=resources/app)
const workbench = join(RES, 'app/apps/web/dist')
mkdirSync(workbench, { recursive: true })
cpSync(join(STAGE, 'apps/web/dist'), workbench, { recursive: true, force: true })
console.log('apps/web/dist ->', workbench)

// 4) 一致性校验：部署后的关键文件必须与源码逐字节一致
let bad = 0
for (const rel of ['electron/main.cjs', 'electron/plugin-host/dsh-web-launcher.cjs', 'electron/plugin-host/scan-extensions.cjs']) {
  const src = readFileSync(join(STAGE, rel))
  const dst = readFileSync(join(RES, 'app.asar.unpacked', rel))
  const same = src.equals(dst)
  console.log(`${same ? 'ok  ' : 'FAIL'} ${rel} (${(dst.length / 1024).toFixed(0)}KB)`)
  if (!same) bad++
}
process.exit(bad ? 1 : 0)
