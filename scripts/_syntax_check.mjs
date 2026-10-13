// Syntax-check built bundles in a deployed/build dir.
// - .js files are parsed as CJS first; if that fails they are re-parsed as ESM.
// - Reports per-file OK/FAIL without executing any plugin code.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join, resolve, extname } from 'node:path'
import { tmpdir } from 'node:os'

const dir = resolve(process.argv[2])
const require = createRequire(import.meta.url)
const vm = await import('node:vm')

let ok = 0
const failures = []

function syntaxCheckCjs(code, file) {
  try { new vm.Script(code, { filename: file }); return true }
  catch (e) { return e }
}

function walk(d) {
  const out = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (extname(p) === '.js') out.push(p)
  }
  return out
}

const files = walk(dir)
const tmp = mkdtempSync(join(tmpdir(), 'dshsyn-'))
for (const f of files) {
  const code = readFileSync(f, 'utf8')
  const err = syntaxCheckCjs(code, f)
  if (err === true) { ok++; continue }
  // try ESM via node --check on a .mjs copy
  const mjs = join(tmp, 'check.mjs')
  writeFileSync(mjs, code)
  try {
    execFileSync(process.execPath, ['--check', mjs], { stdio: 'pipe' })
    ok++
  } catch (e) {
    failures.push([f, String(e.stderr || err).split('\n').slice(0, 3).join(' | ')])
  }
}
try { rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`syntax-checked ${files.length} files in ${dir}`)
console.log(`  ok: ${ok}`)
console.log(`  fail: ${failures.length}`)
for (const [f, m] of failures) console.log('  FAIL', f, '->', m)
process.exit(failures.length ? 1 : 0)
