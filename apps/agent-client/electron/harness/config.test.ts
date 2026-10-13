/**
 * resolveMcpServers 单元测试。
 *
 * 验证 MCP 服务器列表可从环境变量（DSH_MCP_SERVERS）或本地文件解析，
 * 并对非法字段做容错。
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { resolveMcpServers } from './config'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('resolveMcpServers', () => {
  const originals: Record<string, string | undefined> = {}

  beforeEach(() => {
    originals.DSH_MCP_SERVERS = process.env.DSH_MCP_SERVERS
  })

  afterEach(() => {
    if (originals.DSH_MCP_SERVERS === undefined) delete process.env.DSH_MCP_SERVERS
    else process.env.DSH_MCP_SERVERS = originals.DSH_MCP_SERVERS
  })

  it('从 DSH_MCP_SERVERS 解析合法数组', () => {
    process.env.DSH_MCP_SERVERS = JSON.stringify([
      { id: 'a', name: 'A', url: 'http://localhost:8017/mcp', enabled: true },
      { id: 'b', name: 'B', url: 'http://localhost:8020/mcp' },
    ])
    const servers = resolveMcpServers(process.env)
    expect(servers.length).toBe(2)
    expect(servers[0]).toMatchObject({ id: 'a', name: 'A', url: 'http://localhost:8017/mcp', enabled: true })
    // 缺省 enabled 应默认为 true
    expect(servers[1].enabled).toBe(true)
  })

  it('DSH_MCP_SERVERS 缺失时返回空数组', () => {
    delete process.env.DSH_MCP_SERVERS
    expect(resolveMcpServers(process.env)).toEqual([])
  })

  it('DSH_MCP_SERVERS 非法 JSON 时返回空数组且不抛出', () => {
    process.env.DSH_MCP_SERVERS = 'not-json'
    expect(resolveMcpServers(process.env)).toEqual([])
  })

  it('跳过缺少必填字段的配置项', () => {
    process.env.DSH_MCP_SERVERS = JSON.stringify([
      { id: 'a', name: 'A', url: 'http://localhost:8017/mcp' },
      { name: 'no-id', url: 'http://x/mcp' } as unknown as never,
      { id: 'c', name: 'C' } as unknown as never,
    ])
    const servers = resolveMcpServers(process.env)
    expect(servers.length).toBe(1)
    expect(servers[0].id).toBe('a')
  })

  it('从 mcp-servers.json 文件解析（指定 cwd）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cfg-'))
    try {
      writeFileSync(
        join(dir, 'mcp-servers.json'),
        JSON.stringify([{ id: 'f', name: 'File', url: 'http://localhost:9999/mcp', enabled: false }]),
      )
      // 确保环境变量为空，走文件分支
      delete process.env.DSH_MCP_SERVERS
      const servers = resolveMcpServers(process.env, dir)
      expect(servers.length).toBe(1)
      expect(servers[0]).toMatchObject({ id: 'f', enabled: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
