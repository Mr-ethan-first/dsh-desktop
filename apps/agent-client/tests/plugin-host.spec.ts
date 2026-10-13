/**
 * Automated tests for the Electron (DeepSeekAgent) in-app plugin host.
 *
 * Exercises the three layers end to end: manifest recognition (parseManifest),
 * durable discovery/enable-disable (PluginRegistry), and the host lifecycle
 * (createPluginHost). The real activation (module load + renderer mount) is
 * stubbed by design; this suite pins the contract the renderer UI and the
 * (future) IPC bridge depend on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../electron/plugin-host/manifest.js'
import { PluginRegistry } from '../electron/plugin-host/registry.js'
import { createPluginHost } from '../electron/plugin-host/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const extensionDir = path.join(repoRoot, 'packages', 'extensions')
const pluginDirs = ['dsh-modlens', 'dsh-node-flow', 'dsh-market'].map(name =>
  path.join(extensionDir, name),
)
const pluginNames = [
  '@deepseek-ai/dsh-modlens',
  '@deepseek-ai/dsh-node-flow',
  '@deepseek-ai/dsh-market',
]

let tmpDir: string
let stateFile: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-test-'))
  for (const dir of pluginDirs) {
    const dest = path.join(tmpDir, path.basename(dir))
    fs.mkdirSync(dest, { recursive: true })
    fs.copyFileSync(path.join(dir, 'package.json'), path.join(dest, 'package.json'))
  }
  stateFile = path.join(tmpDir, '.plugin-state.json')
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseManifest', () => {
  it('recognizes the deepseek-agent-plugin contract', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(pluginDirs[0], 'package.json'), 'utf8'),
    )
    const m = parseManifest(pkg)
    expect(m).not.toBeNull()
    expect(m!.name).toBe('@deepseek-ai/dsh-modlens')
    expect(m!.source).toBe('deepseek-agent-plugin')
    expect(m!.capabilities).toEqual(['vision'])
    expect(m!.entry).toBe('./dsh/index.js')
    expect(m!.ui).toBe('./dsh/client.js')
    // No displayName in the section -> falls back to package name.
    expect(m!.displayName).toBe('@deepseek-ai/dsh-modlens')
  })

  it('falls back to the dsh (cordis bundle) section', () => {
    const pkg = {
      name: 'foo',
      version: '1.0.0',
      main: './lib/main.js',
      dsh: { capabilities: ['x'], ui: './ui.js' },
    }
    const m = parseManifest(pkg)
    expect(m).not.toBeNull()
    expect(m!.source).toBe('dsh')
    expect(m!.capabilities).toEqual(['x'])
    expect(m!.ui).toBe('./ui.js')
    // entry resolves from main when the dsh section omits it.
    expect(m!.entry).toBe('./lib/main.js')
  })

  it('prefers deepseek-agent-plugin over dsh when both present', () => {
    const pkg = {
      name: 'foo',
      version: '1.0.0',
      main: './lib/main.js',
      'deepseek-agent-plugin': { capabilities: ['a'], entry: './host.js', ui: './h.js' },
      dsh: { capabilities: ['b'] },
    }
    const m = parseManifest(pkg)
    expect(m!.source).toBe('deepseek-agent-plugin')
    expect(m!.capabilities).toEqual(['a'])
    expect(m!.entry).toBe('./host.js')
  })

  it('filters non-string capabilities and returns null for non-plugins', () => {
    expect(parseManifest({ name: 'x' })).toBeNull()
    expect(parseManifest(null)).toBeNull()
    const pkg = {
      name: 'foo',
      version: '1.0.0',
      'deepseek-agent-plugin': { capabilities: ['ok', 1, null, 'also'] },
    }
    const m = parseManifest(pkg)
    expect(m!.capabilities).toEqual(['ok', 'also'])
  })
})

describe('PluginRegistry', () => {
  it('discovers exactly the three plugins with correct manifests', () => {
    const reg = new PluginRegistry(tmpDir, stateFile)
    const found = reg.list()
    const names = found.map(p => p.name).sort()
    expect(names).toEqual([...pluginNames].sort())
    const modlens = found.find(p => p.name === '@deepseek-ai/dsh-modlens')!
    expect(modlens.capabilities).toEqual(['vision'])
    expect(modlens.source).toBe('deepseek-agent-plugin')
    const market = found.find(p => p.name === '@deepseek-ai/dsh-market')!
    expect(market.ui).toBe('./client/client.js')
  })

  it('defaults every plugin to enabled', () => {
    const reg = new PluginRegistry(tmpDir, stateFile)
    expect(reg.enabledList()).toHaveLength(3)
    for (const name of pluginNames) expect(reg.isEnabled(name)).toBe(true)
  })

  it('persists enable/disable and survives a fresh registry instance', () => {
    const regA = new PluginRegistry(tmpDir, stateFile)
    regA.setEnabled('@deepseek-ai/dsh-node-flow', false)
    expect(regA.isEnabled('@deepseek-ai/dsh-node-flow')).toBe(false)
    expect(regA.enabledList()).toHaveLength(2)

    // A second instance sharing the state file must observe the persisted choice.
    const regB = new PluginRegistry(tmpDir, stateFile)
    expect(regB.isEnabled('@deepseek-ai/dsh-node-flow')).toBe(false)
    expect(regB.enabledList()).toHaveLength(2)

    // Re-enable and confirm durability again.
    regB.setEnabled('@deepseek-ai/dsh-node-flow', true)
    expect(new PluginRegistry(tmpDir, stateFile).isEnabled('@deepseek-ai/dsh-node-flow')).toBe(true)
    expect(new PluginRegistry(tmpDir, stateFile).enabledList()).toHaveLength(3)
  })

  it('writes a durable state JSON at the configured path', () => {
    new PluginRegistry(tmpDir, stateFile).setEnabled('@deepseek-ai/dsh-market', false)
    expect(fs.existsSync(stateFile)).toBe(true)
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(saved.enabled['@deepseek-ai/dsh-market']).toBe(false)
  })
})

describe('createPluginHost', () => {
  it('throws without a pluginsDir', () => {
    // @ts-expect-error testing the guard
    expect(() => createPluginHost({})).toThrow()
    // @ts-expect-error testing the guard
    expect(() => createPluginHost()).toThrow()
  })

  it('lists discovered plugins and activates idempotently', async () => {
    const host = createPluginHost({ pluginsDir: tmpDir, stateFile })
    expect(host.list()).toHaveLength(3)

    const target = host.list().find(p => p.name === '@deepseek-ai/dsh-modlens')!
    const first = await host.activate(target)
    expect(first.name).toBe('@deepseek-ai/dsh-modlens')
    expect(first.capabilities).toEqual(['vision'])
    expect(typeof first.activatedAt).toBe('number')

    // Activating again returns the same record (idempotent).
    const again = await host.activate(target)
    expect(again).toBe(first)

    host.deactivate('@deepseek-ai/dsh-modlens')
    expect(host.registry.isEnabled('@deepseek-ai/dsh-modlens')).toBe(true) // deactivate only clears the activation map
  })
})
