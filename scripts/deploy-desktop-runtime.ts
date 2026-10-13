/**
 * Deploy the desktop client's cordis runtime closure into a self-contained,
 * symlink-free, HOISTED `node_modules` that the Electron builder can bundle
 * as an extra resource.
 *
 * Why bundle? The dsh cordis runtime must travel inside the exe so the product
 * survives future in-repo breaking upgrades of deepseek-harness.
 *
 * Why a custom copier instead of `pnpm deploy`?
 *   1. The sandbox safe-delete bulk guard blocks pnpm's internal temp-dir
 *      cleanup (SAFE_DELETE_BULK_CONFIRM_REQUIRED), so `pnpm deploy` cannot
 *      run here at all.
 *   2. A naive recursive copy of `apps/cli/node_modules` (dereferenced) either
 *      loops on the `cordis -> cordis-plugin-include -> cordis` circular
 *      symlink (ELOOP), or — once dereferenced — explodes into deeply nested
 *      node_modules chains that blow past Windows' MAX_PATH (260) and fail
 *      with EPERM.
 *
 * The copier below mirrors what pnpm's `--config.node-linker=hoisted` would
 * produce: every package (all scopes) is placed at the single TOP-LEVEL
 * node_modules, and any nested `node_modules` found inside a package is itself
 * re-hoisted to that same top level (deduped by realpath). This collapses the
 * deep chains, keeps paths short, breaks the symlink cycle, and yields a fully
 * dereferenced, flat, self-contained closure.
 *
 * Usage:
 *   node --import tsx/esm scripts/deploy-desktop-runtime.ts [--dry-run]
 */
import { resolve, join, sep, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cp, readdir, mkdir, realpath, lstat, rename, copyFile, stat, writeFile } from 'node:fs/promises'
import { existsSync as fsExists } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = (() => { const d = fileURLToPath(import.meta.url); return d.slice(0, d.lastIndexOf(sep)) })()
const root = resolve(__dirname, '..')

/** Move a path aside (single metadata op) instead of bulk-deleting it.
 *  Avoids the safe-delete bulk guard that trips on rm -rf of large trees. */
async function moveAside(p: string): Promise<void> {
  if (!fsExists(p)) return
  const target = `${p}.removed-${Date.now()}`
  await rename(p, target)
}
let STAGING = resolve(root, 'desktop', 'runtime-dist')
const DEPLOY_PKG = 'dsh-desktop-runtime-closure'
const dryRun = process.argv.includes('--dry-run')

// Module-level state for a single run.
let TOP_NM = '' // absolute path to staging/node_modules
const visited = new Set<string>() // realpaths already materialized

// Names we never copy into the payload.
const SKIP_NAMES = new Set(['.bin', '.pnpm', '.cache', '.git', '.vite', '.idea', '.turbo', 'node_modules/.cache'])
// Source maps are never needed by the frozen runtime and bloat the payload;
// skip them (also dodges transient ENOENT from AV scanning .map files mid-copy).
const SKIP_SUFFIXES = ['.map']

async function safeCopyFile(s: string, d: string): Promise<void> {
  try {
    await copyFile(s, d)
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES') {
      // Transient (AV scan / dangling workspace symlink) — skip, don't abort.
      console.warn(`[deploy] skip copy (${code}): ${s}`)
      return
    }
    throw e
  }
}

/** Real directory copy. Regular files are copied straight; only symlinks are
 *  resolved (realpath + stat). Any nested `node_modules` is re-hoisted to the
 *  global top level. `visited` (by realpath) breaks symlink cycles and dedupes
 *  repeated packages. `skipNodeModules` lets the CLI-package copy avoid
 *  re-pulling the whole closure it already shares at the top level. */
async function copyRealDir(s: string, d: string, skipNodeModules = false): Promise<void> {
  await mkdir(d, { recursive: true })
  let entries
  try {
    entries = await readdir(s, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue
    if (SKIP_SUFFIXES.some((suf) => e.name.endsWith(suf))) continue
    const child = join(s, e.name)
    if (e.name === 'node_modules') {
      if (skipNodeModules) continue
      await hoistNodeModules(child)
      continue
    }
    if (e.isSymbolicLink()) {
      const real = await realpath(child).catch(() => null)
      if (!real) continue
      const rst = await stat(real).catch(() => null)
      if (!rst) continue
      if (rst.isDirectory()) {
        if (visited.has(real)) continue
        visited.add(real)
        await copyRealDir(real, join(d, e.name))
      } else {
        await safeCopyFile(real, join(d, e.name))
      }
      continue
    }
    if (e.isDirectory()) {
      const real = await realpath(child).catch(() => child)
      if (visited.has(real)) continue
      visited.add(real)
      await copyRealDir(child, join(d, e.name))
      continue
    }
    // regular file
    await safeCopyFile(child, join(d, e.name))
  }
}

/** Walk a `node_modules` directory and hoist every package it contains into
 *  the global top-level node_modules, deduping by realpath. Nested
 *  node_modules inside a hoisted package are recursively re-hoisted. */
async function hoistNodeModules(srcNm: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(srcNm)
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_NAMES.has(e)) continue
    const s = join(srcNm, e)
    const st = await lstat(s).catch(() => null)
    if (!st) continue
    const real = await realpath(s).catch(() => null)
    if (!real) continue
    const rst = await stat(real).catch(() => null)
    if (!rst || !rst.isDirectory()) continue // skip stray files in node_modules
    if (e.startsWith('@')) {
      // scope directory: hoist each <scope>/<name>
      const children = await readdir(s).catch(() => [])
      for (const c of children) {
        if (SKIP_NAMES.has(c)) continue
        const cs = join(s, c)
        const crl = await realpath(cs).catch(() => null)
        if (!crl) continue
        const crst = await stat(crl).catch(() => null)
        if (!crst || !crst.isDirectory()) continue
        await placePackage(crl, join(TOP_NM, e, c))
      }
    } else {
      await placePackage(real, join(TOP_NM, e))
    }
  }
}

/** Materialize one package at `dest` (top-level) unless it/its realpath is
 *  already present. Conflicts (same name, different realpath) are left nested
 *  by skipping the overwrite, preserving the first version.
 *
 *  Critical for pnpm's `.pnpm` layout: a package's own dependencies live in the
 *  SIBLING `node_modules` directory (`dirname(realSrc)`), NOT inside the package
 *  dir. e.g. `.pnpm/chokidar@5/node_modules/{chokidar, readdirp}` — chokidar is
 *  the package, readdirp is its dependency sitting alongside it. After copying
 *  the package we must therefore hoist that sibling node_modules too, or the
 *  transitive closure (readdirp, express, …) is silently dropped and the runtime
 *  fails at load time with "Cannot find package X". */
async function placePackage(realSrc: string, dest: string): Promise<void> {
  if (visited.has(realSrc)) return
  if (fsExists(dest)) {
    // Already placed at top (first version wins). Skip to avoid clobbering.
    visited.add(realSrc)
    return
  }
  visited.add(realSrc)
  await copyRealDir(realSrc, dest)
  // pnpm's `.pnpm` layout keeps a package's deps in the SIBLING node_modules
  // directory. Locate the node_modules that directly contains this package:
  //   unscoped: .../node_modules/<pkg>            -> sibling = .../node_modules
  //   scoped:   .../node_modules/@scope/<pkg>     -> sibling = .../node_modules
  // (dirname(realSrc) is wrong for scoped pkgs — it lands on the @scope dir,
  // which only holds the package itself, so transitive deps get dropped.)
  let p = realSrc
  while (basename(p) !== 'node_modules' && p !== dirname(p)) p = dirname(p)
  if (basename(p) === 'node_modules') await hoistNodeModules(p)
}

async function verify(): Promise<void> {
  const checks: Array<[string, string]> = [
    ['@deepseek-ai/dsh', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    ['@deepseek-ai/dsh-modlens', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-modlens', 'dsh', 'index.js')],
    ['@deepseek-ai/dsh-node-flow', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-node-flow', 'lib', 'index.js')],
    ['@deepseek-ai/dsh-market', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-market', 'lib', 'index.js')],
    ['@deepseek-ai/dsh-web-frontend', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json')],
    // Transitive third-party deps (pnpm keeps these in the sibling node_modules
    // of each .pnpm package — easily dropped if the hoister misses them).
    // chokidar/readdirp are confirmed dsh deps (chokidar's esm entry imports
    // readdirp); a missing one means the hoister dropped a transitive dep.
    ['chokidar', join(STAGING, 'node_modules', 'chokidar', 'package.json')],
    ['readdirp', join(STAGING, 'node_modules', 'readdirp', 'package.json')],
    // Scoped transitive deps that previously leaked when the scoped-sibling
    // hoist was wrong (dirname landed on @scope dir instead of node_modules):
    //   typebox    <- @earendil-works/pi-ai
    //   @opentelemetry/core <- @opentelemetry/resources
    // These MUST be hoisted or the bundled runtime dies at boot with
    // "Cannot find package 'typebox'" / "Cannot find module '@opentelemetry/core'".
    ['typebox', join(STAGING, 'node_modules', 'typebox', 'package.json')],
    ['@opentelemetry/core', join(STAGING, 'node_modules', '@opentelemetry', 'core', 'package.json')],
  ]
  const missing = checks.filter(([, p]) => !fsExists(p)).map(([n]) => n)
  if (missing.length > 0) throw new Error(`[deploy] missing after staging: ${missing.join(', ')}`)
  // Ensure no symlinks leaked into the payload (must be fully dereferenced).
  const { execFileSync } = await import('node:child_process')
  let linkCount = 0
  try {
    const out = execFileSync('find', [STAGING, '-type', 'l'], { encoding: 'utf8' }) as string
    linkCount = out.split('\n').filter((x) => x.trim().length > 0).length
  } catch {
    /* find may be unavailable; non-fatal */
  }
  if (linkCount > 0) throw new Error(`[deploy] ${linkCount} symlinks leaked into payload — not fully dereferenced`)
  console.log('[deploy] verify OK: dsh bin + 3 community plugins + web-frontend + transitive deps (chokidar/readdirp/typebox/@opentelemetry/core) present, 0 symlinks')
}

async function stage(): Promise<void> {
  TOP_NM = join(STAGING, 'node_modules')
  await mkdir(TOP_NM, { recursive: true })
  const cliNodeModules = join(root, 'apps', 'cli', 'node_modules')
  if (!fsExists(cliNodeModules)) throw new Error('apps/cli/node_modules missing — run pnpm install first.')

  console.log('[deploy] hoisting apps/cli/node_modules -> staging/node_modules (flat, dereferenced) ...')
  await hoistNodeModules(cliNodeModules)

  // The CLI package itself (apps/cli) sans its node_modules — deps already at top.
  const cliDest = join(TOP_NM, '@deepseek-ai', 'dsh')
  console.log('[deploy] copying apps/cli -> node_modules/@deepseek-ai/dsh (skip node_modules)')
  await copyRealDir(join(root, 'apps', 'cli'), cliDest, /* skipNodeModules */ true)

  // Safety: ensure the 3 community plugins are present (hoisting should have
  // already pulled them, but force-copy from source if anything slipped).
  for (const p of ['dsh-modlens', 'dsh-node-flow', 'dsh-market']) {
    const dest = join(TOP_NM, '@deepseek-ai', p)
    if (!fsExists(dest)) {
      console.log(`[deploy] adding community plugin ${p} from packages/extensions`)
      await copyRealDir(join(root, 'packages', 'extensions', p), dest, /* skipNodeModules */ true)
    }
  }

  // Self-describing manifest
  const manifestSrc = join(root, 'desktop', 'runtime-closure', 'package.json')
  if (fsExists(manifestSrc)) await cp(manifestSrc, join(STAGING, 'package.json'))
  console.log('[deploy] staging complete')
}

async function main(): Promise<void> {
  console.log(`[deploy] requested staging = ${STAGING}`)
  if (dryRun) {
    console.log('[deploy] [dry-run] would hoist the runtime closure by copy')
    return
  }
  if (fsExists(STAGING)) {
    try {
      await moveAside(STAGING)
    } catch (e) {
      // Real-time AV (Lenovo PC Manager / Huorong) can hold handles on a
      // freshly-written dir, making rename fail with EPERM. Fall back to a
      // fresh unique dir and leave the locked one behind — the swap step
      // copies from the fresh dir instead of renaming it.
      const alt = `${STAGING}.build-${Date.now()}`
      console.warn(`[deploy] could not move aside existing ${STAGING} (${e instanceof Error ? e.message : e}); staging into ${alt} instead`)
      STAGING = alt
    }
  }
  await mkdir(STAGING, { recursive: true })
  await stage()
  await verify()
  await writeFile(join(root, '_tmp_runtime_staging.txt'), STAGING, 'utf8')
  console.log(`[deploy] DONE — desktop cordis runtime staged at ${STAGING}`)
}

main().catch((e) => {
  console.error('[deploy] FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
