/**
 * Automated test for the community-plugin catalog data contract.
 *
 * The `plugin:catalog` IPC handler (main.cjs) normalizes the vendored
 * dsh-market registry-snapshot.json. This suite pins the source-data invariants
 * the handler relies on, so a broken/missing snapshot fails fast. Pure-Node,
 * runs under the isolated vitest config (no Electron / Cordis required).
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const regPath = path.join(repoRoot, 'packages', 'extensions', 'dsh-market', 'data', 'registry-snapshot.json')

function normalize() {
  const data = JSON.parse(fs.readFileSync(regPath, 'utf8'))
  return (Array.isArray(data.plugins) ? data.plugins : []).map((p: any) => ({
    name: p.name || '',
    owner: p.owner || '',
    url: p.url || '',
    page: p.page || '',
    category: p.category || '',
    description: (p.description && (p.description.en || p.description.zh)) || '',
    stars: typeof p.stars === 'number' ? p.stars : 0,
    tarball: p.tarball || '',
    install: p.install || '',
  }))
}

describe('community catalog (registry-snapshot.json)', () => {
  it('exists and parses', () => {
    expect(fs.existsSync(regPath)).toBe(true)
    expect(() => normalize()).not.toThrow()
  })

  it('contains the full curated set (>= 2000 plugins)', () => {
    expect(normalize().length).toBeGreaterThanOrEqual(2000)
  })

  it('resolves known capability-gap plugins to correct GitHub repos', () => {
    const items = normalize()
    const byName = (n: string) => items.find((i: any) => i.name === n)
    const memory = byName('dsh-memory')
    expect(memory).toBeDefined()
    expect(memory.url).toBe('https://github.com/FuRongJun-1999/dsh-memory')
    expect(memory.description.length).toBeGreaterThan(0)

    const atfile = byName('dsh-at-file')
    expect(atfile).toBeDefined()
    expect(atfile.url).toBe('https://github.com/omdsh-dev/dsh-at-file')

    const genui = byName('dsh-genui')
    expect(genui).toBeDefined()
    expect(genui.url).toBe('https://github.com/omdsh-dev/dsh-genui')
  })

  it('every entry carries a name and a github url', () => {
    const items = normalize()
    for (const i of items) {
      expect(i.name).toBeTruthy()
      expect(i.url.startsWith('https://github.com/')).toBe(true)
    }
  })
})
