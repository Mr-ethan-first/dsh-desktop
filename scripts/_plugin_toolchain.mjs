// Reuse the main workspace's toolchain (typescript/tsdown/vitest/@types/node)
// and the deployed runtime's shippable deps (ws, @deepseek-ai/*, cordis) by
// symlinking them into a plugin's node_modules. Avoids npm/pnpm entirely
// (their arborist crashes on this box) and guarantees version parity with the
// host app (alpha.1 dsh + cordis 4.0.1).
import { mkdirSync, symlinkSync, existsSync, lstatSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const pluginDir = resolve(process.argv[2])
const RUNTIME = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'
const WS = 'D:/WorkSpace/deepseek-harness-master/node_modules'

const link = (target, linkPath, kind = 'junction') => {
  if (!existsSync(target)) { console.log('SKIP (missing source):', linkPath, '->', target); return }
  if (existsSync(linkPath)) { console.log('exists (skip):', linkPath); return } // never rm junctions
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, kind)
  console.log('linked', linkPath, '->', target)
}
const readTarget = (p) => { try { return require('node:fs').readlinkSync(p) } catch { return '' } }

const nm = resolve(pluginDir, 'node_modules')
mkdirSync(nm, { recursive: true })

// Host dsh/cordis (alpha.1) — single source of truth at runtime
link(resolve(RUNTIME, '@deepseek-ai'), resolve(nm, '@deepseek-ai'))
link(resolve(RUNTIME, '@deepseek-ai', 'cordis'), resolve(nm, 'cordis'))
// Shippable runtime deps present in deployed runtime
link(resolve(RUNTIME, 'ws'), resolve(nm, 'ws'))
// lightningcss: imported by tsdown.config.ts at config-load time
link(resolve(WS, 'lightningcss'), resolve(nm, 'lightningcss'))
// Build/test toolchain from the main workspace (already built & working)
link(resolve(WS, 'typescript'), resolve(nm, 'typescript'))
link(resolve(WS, 'tsdown'), resolve(nm, 'tsdown'))
link(resolve(WS, 'vitest'), resolve(nm, 'vitest'))
link(resolve(WS, '@types', 'node'), resolve(nm, '@types', 'node'))
// @types/ws: prefer runtime, else workspace
const wsTypes = existsSync(resolve(RUNTIME, '@types', 'ws')) ? resolve(RUNTIME, '@types', 'ws') : resolve(WS, '@types', 'ws')
link(wsTypes, resolve(nm, '@types', 'ws'))

console.log('toolchain linked for', pluginDir)
