/**
 * Headless 评测驱动（rubric-eval / AgentCompass 桥接）。
 *
 * 复用客户端真实 harness 核心（context / tools / session / agent-loop / fs-tools），
 * 注入一个脚本化 mock LLM，跑出一个真实 turn/step 循环，捕获：
 *   - 实际「尝试」的工具调用（tool/call 事件）
 *   - 实际「成功执行」的工具调用（排除 pre-execute 被拒绝 / 执行报错）
 *   - 轨迹、步数、耗时、turn 结束原因
 * 并以 JSON 输出，供 Python 侧 rubric-eval 评估。
 *
 * 运行：tsx driver.ts '<scenario-json>'
 * 零外部依赖（仅 node:fs / node:os / node:path / node:crypto），无需 pnpm install。
 */
import { Context } from '../context.js'
import { ToolRuntime } from '../tools.js'
import { SessionStore, createSessionId } from '../session.js'
import { AgentLoop, AgentRegistry } from '../agent-loop.js'
import { registerFsTools } from '../tools/fs-tools.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- 读取场景 ----
const rawArg = process.argv[2] || process.env.EVAL_SCENARIO || '{}'
const scenario = JSON.parse(rawArg)
const task: string = scenario.task || 'execute the task'
const steps: Array<{ content?: string; toolCalls?: Array<{ name: string; args?: Record<string, unknown> }> }> =
  scenario.steps || []
const finalContent: string = scenario.finalContent ?? ''
const maxToolSteps: number = scenario.maxToolSteps ?? 8
const secureHighRisk: boolean = !!scenario.secureHighRisk
const timeoutMs: number = scenario.timeoutMs ?? 8000

// ---- 隔离工作区 ----
const workDir = mkdtempSync(join(tmpdir(), 'dsh-eval-'))
const workspace = { workDir, permission: 'execute' as const }

// ---- 启动真实 harness 核心 ----
const ctx = new Context()
const tools = new ToolRuntime(ctx) // ctx.tools
const sessions = new SessionStore(ctx) // ctx.sessions
const agents = new AgentRegistry(ctx) // ctx.agents
// secureHighRisk 场景使用正式能力 secureHighRiskTools='deny'（优化后的产品能力）
const agentLoop = new AgentLoop(ctx, {
  secureHighRiskTools: secureHighRisk ? 'deny' : 'allow',
}) // ctx.agentLoop / 注册 agent 工厂

registerFsTools(ctx, workspace)

// ---- 脚本化 mock LLM（按步返回工具调用 / 终态文本）----
let stepIdx = 0
const mockLlm = {
  async generate() {
    if (stepIdx >= steps.length) {
      return { content: finalContent, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
    }
    const step = steps[stepIdx++]
    const toolCalls = (step.toolCalls || []).map((tc, i) => ({
      id: `call_${stepIdx}_${i}`,
      type: 'function' as const,
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }))
    return { content: step.content ?? '', toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  },
}
// ReactLoopAgent 读取 loopCtx.llm
;(ctx as unknown as { llm: typeof mockLlm }).llm = mockLlm

// ---- 捕获会话事件 ----
const attempted: Array<{ name: string; args: Record<string, unknown> }> = []
const executed: Array<{ name: string; args: Record<string, unknown> }> = []
const executedOk: Array<{ name: string; ok: boolean }> = []
const assistant: string[] = []
let turnEnd: string | null = null

ctx.on('session/event', (_session: unknown, event: any) => {
  if (event.type === 'tool/call') {
    attempted.push({ name: event.data.name, args: event.data.args })
  } else if (event.type === 'tool/result') {
    const text: string = (event.data.message?.content?.[0]?.text as string) || ''
    const isErr = text.startsWith('Error') || text.startsWith('Denied') || text.startsWith('Blocked')
    executedOk.push({ name: event.data.name, ok: !isErr })
    // 仅成功执行的工具计入「已执行」（被拒/报错不计入，否则会扭曲护栏判定）
    if (!isErr) executed.push({ name: event.data.name, args: {} })
  } else if (event.type === 'assistant/message') {
    const blocks = event.data?.message?.content || []
    assistant.push(blocks.map((b: any) => b.text || '').join(''))
  } else if (event.type === 'turn/end') {
    turnEnd = event.data?.reason ?? 'unknown'
  }
})

// ---- 运行一个 turn ----
const id = createSessionId()
const agent = agentLoop.create(id, { maxToolSteps }, { cwd: workDir, title: 'eval' })
const t0 = Date.now()
agent.followup([{ type: 'text', text: task }])

// 轮询等待 turn 结束
const start = Date.now()
while (Date.now() - start < timeoutMs) {
  if (agent.status === 'idle' && turnEnd) break
  await new Promise((r) => setTimeout(r, 15))
}
const latency_ms = Date.now() - t0

const output = assistant.join('\n').trim()
const result = {
  output,
  // 成功执行的工具（用于 rubric-eval 的 tool_calls）
  tool_calls: executed.map((t) => ({ name: t.name, args: t.args })),
  // 所有「尝试」的工具（含被拒/报错）——用于护栏分析
  attempted_tool_calls: attempted,
  tool_results: executedOk,
  trace: executedOk.map((t, i) => ({ step: i + 1, tool: t.name, ok: t.ok })),
  latency_ms,
  steps: executed.length,
  attempted_steps: attempted.length,
  completed: turnEnd === 'completed',
  turn_end_reason: turnEnd,
  work_dir: workDir,
}

process.stdout.write(JSON.stringify(result))
process.exit(0)
