// Replicate the Cordis plugin-group name mapping for BUILD-TIME resolution.
//
// The deployed runtime (D:/DeepSeekAgent/resources/dsh-runtime) ships every
// @deepseek-ai/* package as a dot-prefixed hashed dir (e.g. `.dsh-settings-XXXX`)
// under node_modules/@deepseek-ai, with NO proper-name entries. The host's
// Cordis loader resolves `@deepseek-ai/<pkg>` -> the hashed dir at RUNTIME, but
// plain Node / tsdown / tsc cannot resolve the logical name at BUILD time.
//
// This script turns bs2/node_modules/@deepseek-ai into a REAL directory that
// holds, for every shipped package, a proper-name junction (<pkg> -> the hashed
// dir). It also drops in a type-only `@deepseek-ai/cordis` stub, because
// `cordis` core is a type-only import in the plugin (erased at build) and is not
// shipped as a standalone package in this runtime.
//
// Only build-time: _plugin_deploy re-junctions @deepseek-ai to the runtime, so
// the deployed plugin is resolved by the host exactly as the other plugins are.
import { readdirSync, readFileSync, existsSync, lstatSync, symlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

const pluginDir = resolve(process.argv[2])
const nm = resolve(pluginDir, 'node_modules')
const aiDir = join(nm, '@deepseek-ai')
const RUNTIME_AI = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai'

// 1. prepare the dir. NEVER delete an existing tree here: a recursive rm of
//    hundreds of junctions trips the sandbox safe-delete guard / AV scan and
//    hangs (SIGTERM). Merge-only is both safe and idempotent.
if (existsSync(aiDir) && lstatSync(aiDir).isSymbolicLink()) {
  // A leftover junction to the runtime cannot hold extra entries; unlink just
  // the reparse point (single node, no recursion).
  try { rmSync(aiDir, { recursive: false, force: true }) } catch (e) { console.log('  unlink junction failed', e.code) }
}
if (!existsSync(aiDir)) mkdirSync(aiDir, { recursive: true })
console.log('prepared (merge mode)', aiDir)

// 2. proper-name junctions -> runtime hashed dirs
let mapped = 0
if (existsSync(RUNTIME_AI)) {
  for (const entry of readdirSync(RUNTIME_AI)) {
    // entries ARE the dot-prefixed hashed dirs; the logical name lives in package.json
    const pkgPath = join(RUNTIME_AI, entry, 'package.json')
    if (!existsSync(pkgPath)) continue
    let name
    try { name = JSON.parse(readFileSync(pkgPath, 'utf8')).name } catch { continue }
    if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue
    const proper = name.slice('@deepseek-ai/'.length)
    const linkPath = join(aiDir, proper)
    if (existsSync(linkPath)) continue
    try { symlinkSync(join(RUNTIME_AI, entry), linkPath, 'junction'); mapped++ }
    catch (e) { console.log('  skip', proper, '->', e.code) }
  }
}
console.log('mapped', mapped, '@deepseek-ai/* proper-name links')

// 3. type-only cordis stub (not shipped as a standalone pkg in this runtime;
//    cordis is consumed only as `import type` and erased at build)
const cordisDir = join(aiDir, 'cordis')
mkdirSync(cordisDir, { recursive: true })
writeFileSync(join(cordisDir, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/cordis',
  version: '4.0.1',
  type: 'module',
  main: 'index.js',
  types: 'index.d.ts',
  exports: {
    '.': {
      types: './index.d.ts',
      default: './index.js',
    },
  },
}, null, 2))
writeFileSync(join(cordisDir, 'index.js'), '// build-time stub for @deepseek-ai/cordis (type-only import, erased at build)\nexport default undefined\n')
writeFileSync(join(cordisDir, 'index.d.ts'), [
  '// Build-time type stub for @deepseek-ai/cordis (type-only import, erased at build).',
  'export type Context = any',
  'export type Service = any',
  'export type Plugin = any',
  'export type Disposable = any',
  'export type Logger = any',
  'export type Lifecycle = any',
  'export const Context: any',
  'export const Service: any',
  'export const Plugin: any',
  'export default undefined as any',
  'declare module "@deepseek-ai/cordis" {',
  '  export * from "./index";',
  '}',
].join('\n'))
console.log('wrote cordis type stub')

console.log('done')
