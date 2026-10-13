/**
 * Automated tests for the dsh web launcher (Electron ↔ `dsh web` backend bridge).
 *
 * Why this matters: the packaged client can only render dsh-web-ui if it can
 * actually *start* the dsh web backend. In a pnpm workspace the `dsh` bin is
 * never linked at the repo root, so the launcher must fall back to
 * "node + entry file" (built `lib/bin.js`, or `src/bin.ts` via tsx).
 *
 * These tests pin that resolution contract, plus the profile-preparation rules
 * (only extensions declaring `dsh.bundle` may become profile bundles — the
 * other four are in-app plugin-host plugins and would break `loadProfile`).
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const launcher = require('../electron/plugin-host/dsh-web-launcher.cjs') as {
  BASE_BUNDLES: string[]
  readCommunityPlugins: (dir: string) => Array<{ name: string; dir: string }>
  prepareDshHome: (opts: {
    extensionsDir: string
    dshHome: string
    profileName?: string
  }) => string
  resolveDshBin: (candidates: string[]) => string | null
  resolveDshLaunch: (opts: {
    cliDir?: string | null
    extraBins?: string[]
    fs?: { existsSync: (p: string) => boolean }
  }) => { bin: string; nodeArgs: string[] } | null
  spawnDshWeb: (opts: {
    bin: string
    port?: number
    dshHome?: string
    extensionsDir?: string
    runtimeModulesDir?: string
    nodeArgs?: string[]
    runtime?: string
    args?: string[]
    baseEnv?: NodeJS.ProcessEnv
    childProcess?: unknown
    onLog?: (m: string) => void
  }) => unknown | null
  ensureExtensionsModuleFallback: (opts: {
    extensionsDir?: string
    runtimeModulesDir?: string
    onLog?: (m: string) => void
  }) => number
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

/** Build a throwaway runtime node_modules skeleton (shared by fallback + spawnDshWeb specs). */
const mkRuntime = () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-modules-'))
  for (const dir of ['react', 'react-dom', 'ws', 'clsx', 'zod']) {
    fs.mkdirSync(path.join(runtime, dir), { recursive: true })
    fs.writeFileSync(path.join(runtime, dir, 'package.json'), JSON.stringify({ name: dir }))
  }
  // `.bin` and hidden entries must never be mirrored.
  fs.mkdirSync(path.join(runtime, '.bin'), { recursive: true })
  fs.writeFileSync(path.join(runtime, '.package-lock.json'), '{}')
  const scope = path.join(runtime, '@deepseek-ai')
  for (const dir of ['cordis', 'schemastery', 'cosmokit', 'dsh-tools']) {
    fs.mkdirSync(path.join(scope, dir), { recursive: true })
    fs.writeFileSync(path.join(scope, dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${dir}` }))
  }
  return runtime
}

/** Build a throwaway extensions dir with one bundle-declaring plugin. */
const mkExtensions = () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-plugins-'))
  const plugin = path.join(ext, 'dsh-demo-plugin')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-demo-plugin',
    dsh: { bundle: {} },
    dependencies: { cordis: '^1', schemastery: '^1' },
  }))
  return ext
}

/** Remove throwaway dirs built above (junctions are unlinked, never followed). */
const rmTemp = (...dirs: string[]) => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
  }
}

describe('resolveDshLaunch', () => {
  const mkFs = (existing: string[]) => ({
    existsSync: (p: string) => existing.includes(p),
  })

  it('prefers an installed executable over the workspace entry files', () => {
    const bin = path.join('repo', 'node_modules', '.bin', 'dsh')
    const fakeFs = mkFs([bin, path.join('repo', 'apps', 'cli', 'lib', 'bin.js')])
    expect(launcher.resolveDshLaunch({
      cliDir: path.join('repo', 'apps', 'cli'),
      extraBins: [bin],
      fs: fakeFs,
    })).toEqual({ bin, nodeArgs: [] })
  })

  it('uses the built CLI entry with plain node when lib/bin.js exists', () => {
    const cliDir = path.join('repo', 'apps', 'cli')
    const built = path.join(cliDir, 'lib', 'bin.js')
    expect(launcher.resolveDshLaunch({ cliDir, fs: mkFs([built]) })).toEqual({
      bin: built,
      nodeArgs: [],
    })
  })

  it('falls back to the TS source and injects --import tsx/esm', () => {
    const cliDir = path.join('repo', 'apps', 'cli')
    const src = path.join(cliDir, 'src', 'bin.ts')
    expect(launcher.resolveDshLaunch({ cliDir, fs: mkFs([src]) })).toEqual({
      bin: src,
      nodeArgs: ['--import', 'tsx/esm'],
    })
  })

  it('returns null when nothing resolvable exists', () => {
    expect(launcher.resolveDshLaunch({ cliDir: path.join('repo', 'apps', 'cli'), fs: mkFs([]) })).toBeNull()
    expect(launcher.resolveDshLaunch({ cliDir: null, extraBins: [] })).toBeNull()
  })

  it('resolves the real repository CLI (regression guard for the workspace bin gap)', () => {
    const cliDir = path.join(repoRoot, 'apps', 'cli')
    const launch = launcher.resolveDshLaunch({ cliDir })
    expect(launch).not.toBeNull()
    expect(['lib/bin.js', 'src/bin.ts'].some(suffix =>
      launch!.bin.replace(/\\/g, '/').endsWith(`apps/cli/${suffix}`),
    )).toBe(true)
  })
})

describe('readCommunityPlugins', () => {
  it('only collects extensions that declare a dsh.bundle', () => {
    const plugins = launcher.readCommunityPlugins(path.join(repoRoot, 'packages', 'extensions'))
    const names = plugins.map((p: { name: string }) => p.name).sort()
    // The two vendored community plugins added for the sidebar / browser
    // integration: dsh-better-sidebar (file preview sidebar) and
    // @yuxianglin/dsh-bridge-browser (in-app browser). Both declare
    // `dsh.bundle`, so the launcher must pick them up.
    expect(names).toEqual([
      '@deepseek-ai/dsh-market',
      '@deepseek-ai/dsh-modlens',
      '@deepseek-ai/dsh-node-flow',
      '@yuxianglin/dsh-bridge-browser',
      'dsh-better-sidebar',
    ])
    // The four in-app plugin-host extensions must NOT become profile bundles,
    // otherwise `loadProfile` throws "declares no dsh.bundle".
    for (const forbidden of ['client-runner', 'host-runner', 'tool-cordis', 'ui-cordis']) {
      expect(names.some((n: string) => n.includes(forbidden))).toBe(false)
    }
  })
})

describe('prepareDshHome', () => {
  it('writes a web profile containing base bundles + every community bundle', () => {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-test-'))
    const returned = launcher.prepareDshHome({
      extensionsDir: path.join(repoRoot, 'packages', 'extensions'),
      dshHome,
      profileName: 'web',
    })
    expect(returned).toBe(dshHome)

    const manifestPath = path.join(dshHome, 'profiles', 'web', 'package.json')
    expect(fs.existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const bundles: string[] = manifest.dsh.profile.bundles

    for (const base of launcher.BASE_BUNDLES) {
      expect(bundles).toContain(base)
    }
    expect(bundles).toContain('@deepseek-ai/dsh-modlens')
    expect(bundles).toContain('@deepseek-ai/dsh-node-flow')
    expect(bundles).toContain('@deepseek-ai/dsh-market')
    expect(bundles).toContain('@yuxianglin/dsh-bridge-browser')
    expect(bundles).toContain('dsh-better-sidebar')

    // Every bundle must resolve to a real directory (junction or real path),
    // otherwise cordis cannot load it.
    const modules = path.join(dshHome, 'profiles', 'web', 'node_modules')
    for (const plugin of launcher.readCommunityPlugins(path.join(repoRoot, 'packages', 'extensions'))) {
      expect(fs.existsSync(path.join(modules, plugin.name))).toBe(true)
    }
  })
})

describe('spawnDshWeb', () => {
  /** Minimal child_process stub that records the spawn call instead of running it. */
  const stubChildProcess = (calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>) => ({
    spawn: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, env: opts.env })
      const noopEmitter = {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: () => undefined,
      }
      return noopEmitter as unknown
    },
  })

  it('places nodeArgs before the entry file and defaults to --no-open (exe window is the only UI)', () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const child = launcher.spawnDshWeb({
      bin: 'C:/repo/apps/cli/src/bin.ts',
      nodeArgs: ['--import', 'tsx/esm'],
      runtime: 'C:/node/node.exe',
      port: 5283,
      childProcess: stubChildProcess(calls),
    })
    expect(child).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:/node/node.exe')
    expect(calls[0].args).toEqual([
      '--import', 'tsx/esm',
      'C:/repo/apps/cli/src/bin.ts',
      'web', '--port', '5283', '--no-open',
    ])
  })

  it('propagates DSH_HOME to the child and honours custom args', () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    launcher.spawnDshWeb({
      bin: 'C:/repo/apps/cli/lib/bin.js',
      port: 5283,
      args: ['web', '--port', '5283', '--no-open'],
      baseEnv: { DSH_HOME: 'C:/home', PATH: 'x' },
      childProcess: stubChildProcess(calls),
    })
    expect(calls[0].args).toEqual(['C:/repo/apps/cli/lib/bin.js', 'web', '--port', '5283', '--no-open'])
    expect(calls[0].env.DSH_HOME).toBe('C:/home')
  })

  it('returns null without a bin instead of spawning', () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    expect(launcher.spawnDshWeb({ bin: '', childProcess: stubChildProcess(calls) })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  // Regression guard (2026-09-15): spawnDshWeb accepted runtimeModulesDir from main.cjs but
  // silently dropped it, so the extensions resolver fallback was never built in an installed
  // copy (the installer strips every plugin's own node_modules by design). Result: every
  // vendored community plugin failed to import its deps inside `dsh web`, boot aborted with
  // AggregateError, and the exe hung forever on "正在启动 DSH Web 工作台…".
  it('builds the extensions resolver fallback from runtimeModulesDir (dropped-arg regression)', () => {
    const runtime = mkRuntime()
    const ext = mkExtensions()
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-spawn-'))
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    try {
      launcher.spawnDshWeb({
        bin: 'C:/repo/apps/cli/lib/bin.js',
        port: 5283,
        dshHome,
        extensionsDir: ext,
        runtimeModulesDir: runtime,
        baseEnv: { PATH: 'x' },
        childProcess: stubChildProcess(calls),
      })
      const mirror = path.join(ext, 'node_modules')
      expect(fs.existsSync(path.join(mirror, 'ws')), 'fallback missing: runtimeModulesDir not forwarded').toBe(true)
      expect(fs.realpathSync(path.join(mirror, 'cordis')))
        .toBe(fs.realpathSync(path.join(runtime, '@deepseek-ai', 'cordis')))
    } finally {
      rmTemp(ext, runtime, dshHome)
    }
  })

  it('logs a loud warning when the extensions resolver fallback cannot exist', () => {
    const ext = mkExtensions()
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-warn-'))
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const logs: string[] = []
    try {
      launcher.spawnDshWeb({
        bin: 'C:/repo/apps/cli/lib/bin.js',
        port: 5283,
        dshHome,
        extensionsDir: ext,
        baseEnv: { PATH: 'x' },
        childProcess: stubChildProcess(calls),
        onLog: (m) => logs.push(m),
      })
      expect(logs.join('\n')).toContain('插件共享解析回退不存在')
    } finally {
      rmTemp(ext, dshHome)
    }
  })
})

describe('resolveDshBin', () => {
  it('returns the first existing candidate, else null', () => {
    const real = fileURLToPath(pathToFileURL(path.join(here, 'dsh-web-launcher.spec.ts')))
    expect(launcher.resolveDshBin([path.join(here, 'nope'), real])).toBe(real)
    expect(launcher.resolveDshBin([path.join(here, 'nope')])).toBeNull()
  })
})

/**
 * Payload-slimming contract (2026-09-11).
 *
 * Each plugin package used to ship its own `node_modules` full of junctions pointing
 * into the runtime. NSIS `File /r` dereferences junctions, so the whole @deepseek-ai
 * tree (~85MB) was packaged twice per plugin *and* once more under resources/packages,
 * inflating the installer payload from ~600MB to 1574MB. Those junctions are stripped
 * from the deployment tree (scripts/_opt_flatten_deploy.mjs) and re-created at runtime
 * as a single shared fallback at <extensionsDir>/node_modules.
 *
 * These tests pin the fallback's shape, because a wrong shape silently breaks plugin
 * module resolution inside `dsh web`.
 */
describe('ensureExtensionsModuleFallback', () => {
  it('mirrors every runtime top-level entry, plus bare names that only exist scoped', () => {
    const runtime = mkRuntime()
    const ext = mkExtensions()
    const created = launcher.ensureExtensionsModuleFallback({ extensionsDir: ext, runtimeModulesDir: runtime })
    const mirror = path.join(ext, 'node_modules')

    for (const dir of ['react', 'react-dom', 'ws', 'clsx', 'zod', '@deepseek-ai']) {
      expect(fs.existsSync(path.join(mirror, dir)), `missing mirror entry ${dir}`).toBe(true)
    }
    // declared bare deps that live under @deepseek-ai in the runtime
    expect(fs.realpathSync(path.join(mirror, 'cordis')))
      .toBe(fs.realpathSync(path.join(runtime, '@deepseek-ai', 'cordis')))
    expect(fs.realpathSync(path.join(mirror, 'schemastery')))
      .toBe(fs.realpathSync(path.join(runtime, '@deepseek-ai', 'schemastery')))
    // transitive bare name not declared by any plugin (the real-world `cosmokit` case)
    expect(fs.realpathSync(path.join(mirror, 'cosmokit')))
      .toBe(fs.realpathSync(path.join(runtime, '@deepseek-ai', 'cosmokit')))
    // hidden entries stay out of the resolver fallback
    expect(fs.existsSync(path.join(mirror, '.bin'))).toBe(false)
    expect(created).toBeGreaterThan(0)
  })

  it('is idempotent and never throws on repeat calls', () => {
    const runtime = mkRuntime()
    const ext = mkExtensions()
    launcher.ensureExtensionsModuleFallback({ extensionsDir: ext, runtimeModulesDir: runtime })
    const second = launcher.ensureExtensionsModuleFallback({ extensionsDir: ext, runtimeModulesDir: runtime })
    expect(second).toBeGreaterThan(0)
    expect(fs.realpathSync(path.join(ext, 'node_modules', 'react')))
      .toBe(fs.realpathSync(path.join(runtime, 'react')))
  })

  it('no-ops (returns 0) when either directory is missing', () => {
    expect(launcher.ensureExtensionsModuleFallback({})).toBe(0)
    expect(launcher.ensureExtensionsModuleFallback({
      extensionsDir: path.join(os.tmpdir(), 'definitely-not-here'),
      runtimeModulesDir: mkRuntime(),
    })).toBe(0)
  })

  it('prepareDshHome builds the fallback when runtimeModulesDir is supplied', () => {
    const runtime = mkRuntime()
    const ext = mkExtensions()
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-fb-'))
    launcher.prepareDshHome({ extensionsDir: ext, dshHome, runtimeModulesDir: runtime })
    expect(fs.existsSync(path.join(ext, 'node_modules', '@deepseek-ai'))).toBe(true)
  })

  it('prepareDshHome leaves an unchanged profile manifest untouched (no mtime churn)', () => {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-idem-'))
    const ext = path.join(repoRoot, 'packages', 'extensions')
    launcher.prepareDshHome({ extensionsDir: ext, dshHome })
    const manifestPath = path.join(dshHome, 'profiles', 'web', 'package.json')
    const before = fs.statSync(manifestPath)
    launcher.prepareDshHome({ extensionsDir: ext, dshHome })
    const after = fs.statSync(manifestPath)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).dsh.profile.bundles.length)
      .toBe(launcher.BASE_BUNDLES.length + 5)
  })
})
