/**
 * 工作区（工作目录 + 权限等级）单元测试。
 *
 * 覆盖：
 *  - 权限强制：只读/读写/读写+执行 三档下各 fs 工具的允许/拒绝行为
 *  - 路径穿越防护
 *  - HarnessApp.setWorkspace / getWorkspace 运行时切换生效
 *  - 非法权限值被安全忽略
 *
 * 无需网络 / 真实 LLM，仅验证本地文件工具与权限模型。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from './context'
import { ToolRuntime } from './tools'
import { registerFsTools, type WorkspaceState } from './tools/fs-tools'
import { HarnessApp } from './app'
import { loadHarnessConfig } from './config'

function mkWorkDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('fs-tools 权限强制', () => {
  let ctx: any
  let tools: any
  let workDir: string
  let ws: WorkspaceState

  beforeEach(() => {
    workDir = mkWorkDir('dsh-ws-')
    ws = { workDir, permission: 'read' }
    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    tools = (ctx as any).tools as ToolRuntime
    registerFsTools(ctx, ws)
  })

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('只读权限：写入文件被拒绝（权限不足）', async () => {
    const r = await tools.execute('fs__write_file', { relPath: 'a.txt', content: 'x' }, { agentId: 't' })
    expect(r.isError).toBe(true)
    expect((r.content[0] as any).text).toContain('权限不足')
  })

  it('只读权限：执行命令被拒绝（权限不足）', async () => {
    const r = await tools.execute(
      'fs__run_command',
      { command: 'node -e "console.log(1)"' },
      { agentId: 't' },
    )
    expect(r.isError).toBe(true)
    expect((r.content[0] as any).text).toContain('权限不足')
  })

  it('只读权限：读取文件允许', async () => {
    // 临时提升到 write 放一个文件，再降回 read 验证读取
    ws.permission = 'write'
    await tools.execute('fs__write_file', { relPath: 'b.txt', content: 'hello' }, { agentId: 't' })
    ws.permission = 'read'
    const r = await tools.execute('fs__read_file', { relPath: 'b.txt' }, { agentId: 't' })
    expect(r.isError).toBe(false)
    expect((r.content[0] as any).text).toContain('hello')
  })

  it('提升到「读写 + 执行」后：写入与执行均允许', async () => {
    ws.permission = 'execute'
    const w = await tools.execute('fs__write_file', { relPath: 'c.txt', content: 'hi' }, { agentId: 't' })
    expect(w.isError).toBe(false)
    expect(existsSync(join(workDir, 'c.txt'))).toBe(true)

    const r = await tools.execute(
      'fs__run_command',
      { command: 'node -e "console.log(\'ok\')"' },
      { agentId: 't' },
    )
    expect(r.isError).toBe(false)
    expect((r.content[0] as any).text).toContain('exitCode: 0')
    expect((r.content[0] as any).text).toContain('ok')
  })

  it('路径穿越被拒绝', async () => {
    ws.permission = 'read'
    const r = await tools.execute('fs__read_file', { relPath: '../escape.txt' }, { agentId: 't' })
    expect(r.isError).toBe(true)
    expect((r.content[0] as any).text).toContain('路径越界')
  })
})

describe('HarnessApp 工作区运行时切换', () => {
  let dshHome: string

  beforeEach(() => {
    dshHome = mkWorkDir('dsh-home-')
  })
  afterEach(() => {
    try {
      rmSync(dshHome, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('setWorkspace / getWorkspace 生效，非法权限被忽略', async () => {
    const cfg = loadHarnessConfig({
      ...process.env,
      DSH_HOME: dshHome,
      DSH_PERSISTENCE: 'memory',
      WORK_DIR: mkWorkDir('dsh-cfg-'),
    } as NodeJS.ProcessEnv)
    const app = new HarnessApp(cfg)
    await app.start()
    try {
      const before = app.getWorkspace()
      expect(before.permission).toBeDefined()
      expect(typeof before.workDir).toBe('string')

      const next = app.setWorkspace({ permission: 'write', workDir: before.workDir })
      expect(next.permission).toBe('write')
      expect(app.getWorkspace().permission).toBe('write')

      // 非法权限值应被忽略，保持原值
      const bad = app.setWorkspace({ permission: 'garbage' as any })
      expect(bad.permission).toBe('write')
      expect(app.getWorkspace().permission).toBe('write')
    } finally {
      await app.stop()
    }
  })
})
