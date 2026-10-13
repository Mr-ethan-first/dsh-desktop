/**
 * AgentLoop.secureHighRiskTools 护栏单元测试。
 *
 * 验证安全增强能力：
 * - 'allow'（默认）：高风险工具无拦截，照常执行（历史行为）
 * - 'deny'：高风险工具（risk==='high'）在 pre-execute 被拒绝
 * - 'ask'：高风险工具在 pre-execute 返回 ask（交由上层确认）
 * - 低风险工具不受护栏影响
 */
import { describe, it, expect } from 'vitest'
import { Context } from './context'
import { ToolRuntime, defineTool } from './tools'
import { AgentRegistry, AgentLoop } from './agent-loop'

const PARAMS = { type: 'object' as const, properties: {} }

function setup(mode?: 'allow' | 'ask' | 'deny') {
  const ctx = new Context()
  const tools = new ToolRuntime(ctx)
  new AgentRegistry(ctx)
  new AgentLoop(ctx, mode ? { secureHighRiskTools: mode } : {})
  return { ctx, tools }
}

describe('AgentLoop.secureHighRiskTools 护栏', () => {
  it("默认 allow：高风险工具被执行（历史行为不变）", async () => {
    const { tools } = setup('allow')
    tools.register(defineTool({ name: 'rm', risk: 'high', parameters: PARAMS, execute: async () => [{ type: 'text', text: 'deleted' }] }))
    const res = await tools.execute('rm', {}, { agentId: 'a' })
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toBe('deleted')
  })

  it("deny：高风险工具被拒绝", async () => {
    const { tools } = setup('deny')
    tools.register(defineTool({ name: 'rm', risk: 'high', parameters: PARAMS, execute: async () => [{ type: 'text', text: 'deleted' }] }))
    const res = await tools.execute('rm', {}, { agentId: 'a' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Denied')
  })

  it("deny：低风险工具不受影响", async () => {
    const { tools } = setup('deny')
    tools.register(defineTool({ name: 'ls', risk: 'low', parameters: PARAMS, execute: async () => [{ type: 'text', text: 'listed' }] }))
    const res = await tools.execute('ls', {}, { agentId: 'a' })
    expect(res.isError).toBe(false)
    expect(res.content[0].text).toBe('listed')
  })

  it("ask：高风险工具被要求确认（不执行）", async () => {
    const { tools } = setup('ask')
    tools.register(defineTool({ name: 'rm', risk: 'high', parameters: PARAMS, execute: async () => [{ type: 'text', text: 'deleted' }] }))
    const res = await tools.execute('rm', {}, { agentId: 'a' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('Approval required')
  })
})
