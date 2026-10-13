/**
 * Swap the freshly-built cordis runtime closure into the deployed exe's
 * resources/dsh-runtime WITHOUT re-running electron-builder.
 *
 * The full exe build is ~28 min; the runtime closure is the only thing #81
 * needs to refresh (the exe binary itself is unchanged). We copy (not rename)
 * to dodge the real-time-AV EPERM lock that Windows throws when renaming a
 * freshly-written directory.
 *
 * Pipeline:
 *   1. read staging path from _tmp_runtime_staging.txt (written by
 *      deploy-desktop-runtime.ts; may be a fresh .build-<ts> dir)
 *   2. sanity-check the staged closure has the dsh bin + transitive deps
 *   3. move the old deployed resources/dsh-runtime aside (rename; settled dir)
 *   4. cpSync the staged node_modules + manifest into place
 *
 * Run: CI=true node scripts/swap-dsh-runtime.mjs
 */
import { existsSync, mkdirSync, renameSync, cpSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO = resolve(process.cwd())
const DEPLOY = 'D:\\DeepSeekAgent\\resources\\dsh-runtime'
const marker = join(REPO, '_tmp_runtime_staging.txt')

function resolveStaging() {
  if (existsSync(marker)) {
    try {
      const p = readFileSync(marker, 'utf8').trim()
      if (p && existsSync(join(p, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return p
    } catch { /* ignore */ }
  }
  const canon = join(REPO, 'desktop', 'runtime-dist')
  if (existsSync(join(canon, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return canon
  throw new Error('no staged runtime closure found (looked at marker + desktop/runtime-dist)')
}

const STAGING = resolveStaging()
console.log(`[swap] staging = ${STAGING}`)
console.log(`[swap] deploy  = ${DEPLOY}`)

const required = [
  ['@deepseek-ai/dsh bin', join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
  ['typebox', join(STAGING, 'node_modules', 'typebox', 'package.json')],
  ['@opentelemetry/core', join(STAGING, 'node_modules', '@opentelemetry', 'core', 'package.json')],
  ['chokidar', join(STAGING, 'node_modules', 'chokidar', 'package.json')],
  ['readdirp', join(STAGING, 'node_modules', 'readdirp', 'package.json')],
]
const missing = required.filter(([, p]) => !existsSync(p)).map(([n]) => n)
if (missing.length > 0) {
  console.error(`[swap] FATAL: staged closure missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('[swap] staged closure sanity OK (dsh + typebox + @opentelemetry/core + chokidar + readdirp)')

function moveAside(p) {
  if (!existsSync(p)) return
  const t = `${p}.removed-${Date.now()}`
  try {
    renameSync(p, t)
    console.log(`[swap] moved aside ${p} -> ${t}`)
  } catch (e) {
    console.warn(`[swap] rename aside failed for ${p} (${e.code || e.message}); will overwrite in place`)
  }
}

moveAside(DEPLOY)
mkdirSync(DEPLOY, { recursive: true })
console.log('[swap] copying node_modules ...')
cpSync(join(STAGING, 'node_modules'), join(DEPLOY, 'node_modules'), { recursive: true, force: true, dereference: true })
try { cpSync(join(STAGING, 'package.json'), join(DEPLOY, 'package.json'), { force: true }) } catch { /* optional */ }
console.log(`[swap] DONE: ${DEPLOY}`)
