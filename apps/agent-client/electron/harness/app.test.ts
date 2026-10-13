import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { HarnessApp } from './app'

describe('HarnessApp.diagnosis', () => {
  it('启动后返回 ready 且无 MCP 时 mcpServers 为空数组', async () => {
    const app = new HarnessApp({
      dshHome: path.join(os.tmpdir(), 'dsh-diag-test'),
      workDir: os.tmpdir(),
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      maxParallelToolCalls: 4,
      mcpServers: [],
      persistenceType: 'memory',
      sqlitePath: '',
      sessionsDir: path.join(os.tmpdir(), 'dsh-diag-sessions'),
      autoLoadSessions: false,
    })
    await app.start()
    const diag = app.diagnosis()
    expect(diag.ready).toBe(true)
    expect(Array.isArray(diag.mcpServers)).toBe(true)
    expect(diag.mcpServers.length).toBe(0)
    await app.stop()
  })
})
