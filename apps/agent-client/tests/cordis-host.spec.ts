/**
 * Automated tests for the in-app Cordis host (cordis-host).
 *
 * Pure-Node: verifies bundle-patch discovery + capability-summary parsing, and
 * the sandbox degrade path (status 'staged' when @deepseek-ai/dsh-app-boot is
 * not linked). Runs under the isolated vitest config (no Cordis setup), so it is
 * executable pre-install — consistent with plugin-host.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBundlePatch, summarizePatch, createCordisHost } from '../electron/plugin-host/cordis-host/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const extDir = path.join(repoRoot, 'packages', 'extensions')
const modlensDir = path.join(extDir, 'dsh-modlens')

describe('findBundlePatch', () => {
  it('resolves a real vendored plugin cordis.patch.yml', () => {
    const p = findBundlePatch(modlensDir)
    expect(p).not.toBeNull()
    expect(p!.replace(/\\/g, '/')).toBe(path.join(modlensDir, 'cordis.patch.yml').replace(/\\/g, '/'))
    expect(fs.existsSync(p!)).toBe(true)
  })

  it('returns null when dsh.bundle.patch is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cordis-no-bundle-'))
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    expect(findBundlePatch(tmp)).toBeNull()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('summarizePatch', () => {
  it('parses insert names from a real patch', () => {
    const p = findBundlePatch(modlensDir)
    const s = summarizePatch(p)
    expect(s.inserts).toContain('@deepseek-ai/dsh-modlens')
    expect(Array.isArray(s.configKeys)).toBe(true)
    expect(Array.isArray(s.services)).toBe(true)
  })

  it('returns an empty summary for a missing patch', () => {
    const s = summarizePatch(null)
    expect(s.inserts).toEqual([])
    expect(s.configKeys).toEqual([])
    expect(s.services).toEqual([])
  })

  it('parses every vendored plugin patch', () => {
    for (const name of ['dsh-modlens', 'dsh-node-flow', 'dsh-market']) {
      const s = summarizePatch(findBundlePatch(path.join(extDir, name)))
      expect(s.inserts.length).toBeGreaterThanOrEqual(1)
      expect(s.inserts[0]).toBe(`@deepseek-ai/${name}`)
    }
  })
})

describe('createCordisHost (sandbox degrade path)', () => {
  it('activates a real plugin as staged (Cordis not linked) with capability summary', async () => {
    const host = createCordisHost({})
    const rec = await host.activate({
      name: '@deepseek-ai/dsh-modlens',
      source: 'deepseek-agent-plugin',
      dir: modlensDir,
      capabilities: ['vision'],
    })
    expect(rec.name).toBe('@deepseek-ai/dsh-modlens')
    // 'active' only when the Cordis runtime is linked (post pnpm install); sandbox → 'staged'.
    expect(['staged', 'active']).toContain(rec.status)
    expect(rec.summary).not.toBeNull()
    expect(rec.summary!.inserts).toContain('@deepseek-ai/dsh-modlens')
    expect(rec.capabilities).toEqual(['vision'])
  })

  it('reports no-bundle for a plugin without dsh.bundle.patch', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cordis-nobundle-'))
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    const host = createCordisHost({})
    const rec = await host.activate({ name: 'x', source: 'dsh', dir: tmp, capabilities: [] })
    expect(rec.status).toBe('no-bundle')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('is idempotent', async () => {
    const host = createCordisHost({})
    const a = await host.activate({
      name: '@deepseek-ai/dsh-node-flow',
      source: 'dsh',
      dir: path.join(extDir, 'dsh-node-flow'),
      capabilities: ['workflow'],
    })
    const b = await host.activate({
      name: '@deepseek-ai/dsh-node-flow',
      source: 'dsh',
      dir: path.join(extDir, 'dsh-node-flow'),
      capabilities: ['workflow'],
    })
    expect(b).toBe(a)
  })
})
