// Junction-link a plugin's node_modules/@deepseek-ai (+ cordis) to the
// DEPLOYED runtime's alpha.1 packages so it compiles against, and ultimately
// requires, the exact host instances (single cordis/dsh graph at runtime).
import { mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const pluginDir = resolve(process.argv[2])
const RUNTIME = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'
const HOST_DAI = resolve(RUNTIME, '@deepseek-ai')

if (!existsSync(HOST_DAI)) { console.error('host @deepseek-ai missing at', HOST_DAI); process.exit(1) }

const nm = resolve(pluginDir, 'node_modules')
mkdirSync(nm, { recursive: true })

const link = (target, linkPath) => {
  if (existsSync(linkPath)) {
    const st = (() => { try { return require('node:fs').lstatSync(linkPath) } catch { return null } })()
    if (st && st.isSymbolicLink()) return
    rmSync(linkPath, { recursive: true, force: true })
  }
  // Windows junction
  symlinkSync(target, linkPath, 'junction')
  console.log('linked', linkPath, '->', target)
}

// @deepseek-ai/* (includes cordis, cosmokit, schemastery, all dsh-*)
link(HOST_DAI, resolve(nm, '@deepseek-ai'))
// bare cordis (better-sidebar imports 'cordis')
link(resolve(HOST_DAI, 'cordis'), resolve(nm, 'cordis'))

console.log('linked host dsh/cordis for', pluginDir)
