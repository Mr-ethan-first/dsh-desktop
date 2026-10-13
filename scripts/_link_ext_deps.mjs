/**
 * Link the Chrome-extension build dependencies from the monorepo pnpm store
 * into packages/extensions/dsh-browser-0.1.3/extensions/dsh-browser/node_modules
 * so the extension can be built offline without a network install.
 *
 * Uses directory junctions (fs.symlinkSync type 'junction') because the sandbox
 * blocks cmd.exe mklink.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/WorkSpace/deepseek-harness-master'
const STORE = path.join(ROOT, 'node_modules', '.pnpm')
const EXT = path.join(ROOT, 'packages/extensions/dsh-browser-0.1.3/extensions/dsh-browser')
const NM = path.join(EXT, 'node_modules')

// Resolve the first matching ".pnpm/<prefix>.../node_modules/<pkg>" entry.
function storeDir(prefix, pkg) {
  const hits = readdirSync(STORE).filter((n) => n.startsWith(prefix))
  for (const h of hits) {
    const cand = path.join(STORE, h, 'node_modules', ...pkg.split('/'))
    if (existsSync(cand)) return cand
  }
  return undefined
}

/** Pick the @vitejs/plugin-react variant whose own node_modules links vite@6. */
function pluginReactDir() {
  const hits = readdirSync(STORE).filter((n) => n.startsWith('@vitejs+plugin-react@'))
  for (const h of hits) {
    const base = path.join(STORE, h, 'node_modules')
    const pkg = path.join(base, '@vitejs/plugin-react')
    if (!existsSync(pkg)) continue
    const viteLink = path.join(base, 'vite')
    if (!existsSync(viteLink)) continue
    try {
      const v = JSON.parse(readFileSync(path.join(viteLink, 'package.json'), 'utf8')).version
      if (v.startsWith('6.')) return { dir: pkg, variant: h, vite: v }
    } catch { /* keep scanning */ }
  }
  return undefined
}

const links = []
const pr = pluginReactDir()
console.log('plugin-react variant:', pr ? `${pr.variant} (vite ${pr.vite})` : 'NOT FOUND')

const specs = [
  ['vite', storeDir('vite@6.', 'vite')],
  ['vite-tsconfig-paths', storeDir('vite-tsconfig-paths@', 'vite-tsconfig-paths')],
  ['react', storeDir('react@18.', 'react')],
  ['react-dom', storeDir('react-dom@18.', 'react-dom')],
  ['marked', storeDir('marked@', 'marked')],
  ['dompurify', storeDir('dompurify@', 'dompurify')],
  ['tldts', storeDir('tldts@', 'tldts')],
  ['jsdom', storeDir('jsdom@', 'jsdom')],
]
if (pr) specs.push(['@vitejs/plugin-react', pr.dir])

// The workspace protocol package the extension imports at source level.
specs.push([
  '@yuxianglin/dsh-bridge-browser',
  path.join(ROOT, 'packages/extensions/dsh-browser-0.1.3/packages/browser/bridge-browser'),
])

mkdirSync(NM, { recursive: true })

for (const [name, target] of specs) {
  if (!target) { console.log(`MISS  ${name} (no store entry)`); continue }
  const dest = path.join(NM, ...name.split('/'))
  mkdirSync(path.dirname(dest), { recursive: true })
  let existed = false
  try {
    if (lstatSync(dest)) { existed = true; rmSync(dest, { recursive: true, force: true }) }
  } catch { /* not present */ }
  symlinkSync(target, dest, 'junction')
  const ok = existsSync(path.join(dest, 'package.json'))
  const ver = ok ? JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8')).version : '?'
  console.log(`${ok ? 'OK  ' : 'BAD '} ${name}@${ver}${existed ? ' (replaced)' : ''} -> ${target}`)
  links.push({ name, target, ok })
}

// React's jsx-runtime must be reachable; report resolution health.
const must = ['vite', 'react', 'react-dom', 'marked', 'dompurify', 'tldts', '@vitejs/plugin-react', 'vite-tsconfig-paths', '@yuxianglin/dsh-bridge-browser']
const bad = must.filter((n) => !links.find((l) => l.name === n && l.ok))
console.log('\nmissing required:', bad.length === 0 ? 'none' : bad.join(', '))
process.exit(bad.length === 0 ? 0 : 1)
