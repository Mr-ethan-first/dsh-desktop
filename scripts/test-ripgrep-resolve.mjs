// Automated test: glob/grep must be able to locate AND launch the packaged
// ripgrep binary. Regression guard for the `ripgrep launch failed` bug caused
// by an empty/absent `@vscode/ripgrep` wrapper package in bundled runtimes.
//
// Run: node scripts/test-ripgrep-resolve.mjs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const { resolveRgPath } = await import(
  pathToFileURL('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js').href
)

let failed = false
function check(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`)
  } else {
    console.error(`FAIL: ${label}`)
    failed = true
  }
}

// 1) resolveRgPath must return an existing binary path (exercises the
//    @vscode/ripgrep wrapper -> platform-package fallback).
const rgPath = await resolveRgPath()
check(typeof rgPath === 'string' && rgPath.length > 0, `resolveRgPath() returned a path: ${rgPath}`)
check(existsSync(rgPath), `resolved ripgrep binary exists on disk`)

// 2) The binary must actually launch (this is what failed before: spawn threw
//    "ripgrep launch failed" because the wrapper import rejected).
const probe = spawnSync(rgPath, ['--version'], { encoding: 'utf8' })
check(probe.status === 0, 'ripgrep launches and exits 0')
check(/ripgrep/i.test(probe.stdout || ''), `ripgrep reports its version: ${(probe.stdout || '').trim().split('\n')[0]}`)

if (failed) {
  console.error('\nOVERALL: FAIL')
  process.exit(1)
}
console.log('\nOVERALL: PASS')
