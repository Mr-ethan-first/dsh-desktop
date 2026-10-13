// Prep a community plugin for building against the DEPLOYED runtime's alpha.1
// @deepseek-ai/* packages. Strips declared @deepseek-ai/* + bare cordis from
// package.json so pnpm install only fetches pure-JS deps; the host dsh/cordis
// are provided later via a junction (resolved at runtime to the single instance).
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const pluginDir = resolve(process.argv[2])
if (!pluginDir) { console.error('usage: node _plugin_prep.mjs <pluginDir>'); process.exit(1) }

const pkgPath = resolve(pluginDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// backup
if (!existsSync(pkgPath + '.orig')) writeFileSync(pkgPath + '.orig', readFileSync(pkgPath))

const BLOCKLIST = new Set([
  'cordis', 'typescript', 'tsdown', 'lightningcss', 'vitest', 'eslint',
  'eslint-plugin-react-hooks', '@eslint/js', 'globals', 'typescript-eslint',
  '@playwright/test', 'jsdom', 'unrun', '@cordisjs/plugin-loader',
  '@huanlin/dsh-plugin-better-locale', 'node-pty',
])
const stripKey = (obj) => {
  if (!obj) return
  for (const k of Object.keys(obj)) {
    if (BLOCKLIST.has(k) || k.startsWith('@deepseek-ai/')) delete obj[k]
  }
}
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies']) {
  stripKey(pkg[field])
}
// safety: remove rc/alpha version pins that would conflict with host
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

// drop lockfile so pnpm resolves fresh without fetching dsh
const lock = resolve(pluginDir, 'pnpm-lock.yaml')
if (existsSync(lock)) rmSync(lock)

console.log('prepped', pluginDir)
console.log('remaining deps:', Object.keys(pkg.dependencies || {}).join(', ') || '(none)')
console.log('remaining devDeps:', Object.keys(pkg.devDependencies || {}).join(', ') || '(none)')
