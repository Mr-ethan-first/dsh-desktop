// Deploy a built community plugin into the deployed app's extensions dir.
// Copies only build artifacts (package.json, cordis.patch.yml, lib/ — no .map,
// no node_modules) plus any runtime-only deps the host runtime does NOT ship
// (argv[4], comma-separated), then recreates runtime junctions so the plugin's
// require('@deepseek-ai/*' | 'cordis' | 'ws') resolves to the host's single
// instance at runtime.
//
// Usage: node _plugin_deploy.mjs <buildDir> <deployName> [extraDepsCsv]
import { cpSync, mkdirSync, symlinkSync, existsSync, lstatSync, rmSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const buildDir = resolve(process.argv[2])
const deployName = process.argv[3] || 'plugin'
const extraDeps = (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean)
const EXT = 'D:/DeepSeekAgent/resources/packages/extensions'
const RUNTIME = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules'
const deployDir = resolve(EXT, deployName)

// restore original package.json if we stripped it during build
const orig = resolve(buildDir, 'package.json.orig')
const pkgSrc = existsSync(orig) ? orig : resolve(buildDir, 'package.json')
if (existsSync(deployDir)) rmSync(deployDir, { recursive: true, force: true })
mkdirSync(deployDir, { recursive: true })

cpSync(pkgSrc, resolve(deployDir, 'package.json'))
for (const f of ['cordis.patch.yml', 'dsh.plugin.json']) {
  if (existsSync(resolve(buildDir, f))) cpSync(resolve(buildDir, f), resolve(deployDir, f))
}
cpSync(resolve(buildDir, 'lib'), resolve(deployDir, 'lib'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
})
console.log('copied build artifacts ->', deployDir)

// runtime junctions
const nm = resolve(deployDir, 'node_modules')
mkdirSync(nm, { recursive: true })
const jlink = (target, name) => {
  const lp = resolve(nm, name)
  if (existsSync(lp)) { if (lstatSync(lp).isSymbolicLink()) return; rmSync(lp, { recursive: true, force: true }) }
  symlinkSync(target, lp, 'junction')
  console.log('junction', name, '->', target)
}
jlink(resolve(RUNTIME, '@deepseek-ai'), '@deepseek-ai')
jlink(resolve(RUNTIME, '@deepseek-ai', 'cordis'), 'cordis')
if (existsSync(resolve(RUNTIME, 'ws'))) jlink(resolve(RUNTIME, 'ws'), 'ws')

// Real-copy deps the host runtime does not provide (with their transitive deps
// resolvable from the build dir). Junctioning these would break if the build
// dir is ever cleaned, so they are shipped as real files.
const copied = new Set()
const shipDep = (name) => {
  if (copied.has(name)) return
  copied.add(name)
  const src = resolve(buildDir, 'node_modules', name)
  if (!existsSync(src)) { console.log('  MISSING dep', name, '(skipped)'); return }
  const dst = resolve(nm, name)
  if (existsSync(dst)) return
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log('shipped dep', name)
  // transitive deps
  let deps = {}
  try { deps = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).dependencies || {} } catch {}
  for (const d of Object.keys(deps)) {
    if (existsSync(resolve(RUNTIME, d))) continue // host provides it
    if (existsSync(resolve(buildDir, 'node_modules', d))) shipDep(d)
  }
}
for (const d of extraDeps) shipDep(d)

console.log('deployed', deployName)
