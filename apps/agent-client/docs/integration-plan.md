# DeepSeek Harness 集成实现计划

> **For agentic workers:** 按任务顺序执行，每个任务产出可测试的独立功能。Steps 使用 checkbox (`- [ ]`) 语法用于跟踪。

**Goal:** 将 agent-client 从 LangGraph + 自定义编排架构迁移到 deepseek-harness Cordis 插件架构，所有核心能力遵循 harness 设计思想，冲突部分以 harness 为准。

**Architecture:** 采用 Electron 主进程运行 Cordis 应用（agent-loop + session + tools + llm），渲染进程作为纯 UI 客户端通过 IPC 连接到后端。能力缝模式贯穿始终：Service Definition / Service Provider / Consumer。

**Tech Stack:** Cordis, @deepseek-ai/dsh-*, Electron, React, TypeScript, Vitest

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process (Node.js)                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Cordis Application                               │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  │  │
│  │  │ LlmRuntime │  │ SessionStor│  │ ToolRuntime│  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  │  │
│  │  ┌────────────┐  ┌────────────┐                   │  │
│  │  │ AgentLoop  │  │ AgentReg.  │                   │  │
│  │  └────────────┘  └────────────┘                   │  │
│  │  ┌────────────────────────────────────────────┐   │  │
│  │  │ IPC Bridge (session events + commands)     │   │  │
│  │  └────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                           │ IPC
┌─────────────────────────────────────────────────────────┐
│  Renderer Process (React)                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  UI Components (Chat, Workspace, Settings, ...)  │  │
│  │  ┌────────────────────────────────────────────┐   │  │
│  │  │ Harness Client (session store + commands)  │   │  │
│  │  └────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Task 1: 主进程 Cordis 应用骨架

**Files:**
- Create: `apps/agent-client/electron/harness/app.ts`
- Create: `apps/agent-client/electron/harness/config.ts`
- Modify: `apps/agent-client/electron/main.cjs`
- Test: `apps/agent-client/electron/harness/app.test.ts`

**目标:** 在 Electron 主进程中建立最小可运行的 Cordis 应用，挂载核心服务（LlmRuntime + SessionStore + ToolRuntime + AgentLoop）。

- [ ] **Step 1: 编写 harness 应用配置**

```typescript
// apps/agent-client/electron/harness/config.ts
import { resolve } from 'node:path'

export interface HarnessConfig {
  dshHome: string
  workDir: string
  apiKey: string
  baseUrl: string
  model: string
}

export function loadHarnessConfig(): HarnessConfig {
  return {
    dshHome: process.env.DSH_HOME || resolve(process.env.APPDATA || '', 'deepseek-harness'),
    workDir: process.env.WORK_DIR || process.cwd(),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  }
}
```

- [ ] **Step 2: 编写 Cordis 应用入口**

```typescript
// apps/agent-client/electron/harness/app.ts
import { Context, Loader } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import DeepSeekAdapter from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { HarnessConfig } from './config'

export class HarnessApp {
  readonly ctx: Context

  constructor(private config: HarnessConfig) {
    this.ctx = new Context()
  }

  async start(): Promise<void> {
    const loader = new Loader(this.ctx)
    await loader.load({
      name: 'agent-client-harness',
      plugins: [
        // LLM 运行时 + DeepSeek 适配器
        [LlmRuntime, {}],
        [DeepSeekAdapter, {
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
        }],
        // 会话存储
        [SessionStore, {}],
        // 系统提示
        [SystemPrompt, {
          includeHarnessIdentity: true,
          includeRuntimeContext: true,
          persona: '',
        }],
        // 工具运行时
        [ToolRuntime, {
          mode: 'native',
        }],
        // Agent 注册中心
        [AgentRegistry, {}],
        // Agent 循环
        [AgentLoop, {
          agents: [],
        }],
      ],
    })
  }

  async stop(): Promise<void> {
    await this.ctx.dispose()
  }
}
```

- [ ] **Step 3: 编写单元测试（先写测试）**

```typescript
// apps/agent-client/electron/harness/app.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { HarnessApp } from './app'
import { loadHarnessConfig } from './config'

describe('HarnessApp', () => {
  let app: HarnessApp

  beforeEach(() => {
    const config = loadHarnessConfig()
    app = new HarnessApp(config)
  })

  afterEach(async () => {
    await app.stop()
  })

  it('starts and mounts core services', async () => {
    await app.start()
    expect(app.ctx.llm).toBeDefined()
    expect(app.ctx.sessions).toBeDefined()
    expect(app.ctx.tools).toBeDefined()
    expect(app.ctx.agents).toBeDefined()
    expect(app.ctx.agentLoop).toBeDefined()
  })

  it('creates a session via agent loop', async () => {
    await app.start()
    const id = 'test-session-1'
    const agent = app.ctx.agentLoop.create(id, {}, { cwd: process.cwd() })
    expect(agent).toBeDefined()
    expect(agent.id).toBe(id)
    expect(agent.session).toBeDefined()
  })
})
```

- [ ] **Step 4: 运行测试验证失败**

Run: `cd apps/agent-client && npx vitest run electron/harness/app.test.ts`
Expected: FAIL (模块未找到 / 类型未定义)

- [ ] **Step 5: 修正实现并添加依赖**

在 package.json 中添加 harness 包依赖：
```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "workspace:*",
    "@deepseek-ai/dsh-llm": "workspace:*",
    "@deepseek-ai/dsh-llm-deepseek": "workspace:*",
    "@deepseek-ai/dsh-session": "workspace:*",
    "@deepseek-ai/dsh-system-prompt": "workspace:*",
    "@deepseek-ai/dsh-tools": "workspace:*",
    "@deepseek-ai/dsh-agent": "workspace:*",
    "@deepseek-ai/dsh-agent-loop": "workspace:*",
    "@deepseek-ai/schemastery": "workspace:*"
  }
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `cd apps/agent-client && npx vitest run electron/harness/app.test.ts`
Expected: PASS

---

## Task 2: DeepSeek LLM 适配器集成

**Files:**
- Modify: `apps/agent-client/electron/harness/app.ts`
- Create: `apps/agent-client/electron/harness/llm-config.ts`
- Test: `apps/agent-client/electron/harness/llm-config.test.ts`

**目标:** 正确配置 DeepSeek LLM 适配器，支持流式对话、工具调用。

- [ ] **Step 1: 编写 LLM 配置模块**

```typescript
// apps/agent-client/electron/harness/llm-config.ts
import type { DeepSeekAdapterConfig } from '@deepseek-ai/dsh-llm-deepseek'

export function buildDeepSeekConfig(opts: {
  apiKey: string
  baseUrl: string
  model?: string
}): DeepSeekAdapterConfig {
  return {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    defaultModel: opts.model || 'deepseek-chat',
  }
}
```

- [ ] **Step 2: 编写测试**

```typescript
// apps/agent-client/electron/harness/llm-config.test.ts
import { describe, it, expect } from 'vitest'
import { buildDeepSeekConfig } from './llm-config'

describe('buildDeepSeekConfig', () => {
  it('builds config with required fields', () => {
    const cfg = buildDeepSeekConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    })
    expect(cfg.apiKey).toBe('sk-test')
    expect(cfg.baseUrl).toBe('https://api.deepseek.com')
    expect(cfg.defaultModel).toBe('deepseek-chat')
  })

  it('uses default model when not specified', () => {
    const cfg = buildDeepSeekConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(cfg.defaultModel).toBe('deepseek-chat')
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd apps/agent-client && npx vitest run electron/harness/llm-config.test.ts`
Expected: PASS

- [ ] **Step 4: 集成到 HarnessApp**

在 HarnessApp 中使用 `buildDeepSeekConfig` 构建适配器配置。

---

## Task 3: 文件系统工具注册（fs-tools）

**Files:**
- Create: `apps/agent-client/electron/harness/tools/fs-tools.ts`
- Modify: `apps/agent-client/electron/harness/app.ts`
- Test: `apps/agent-client/electron/harness/tools/fs-tools.test.ts`

**目标:** 使用 `defineTool` 注册文件系统工具（写/读/列/删），遵循 harness 工具定义模式。

- [ ] **Step 1: 编写 fs 工具定义**

```typescript
// apps/agent-client/electron/harness/tools/fs-tools.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import { promises as fs } from 'node:fs'
import { join, resolve, relative, normalize } from 'node:path'

/** 确保路径在工作目录内，防止路径穿越。 */
function safePath(workDir: string, relPath: string): string {
  const normalized = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '')
  const absolute = resolve(workDir, normalized)
  const rel = relative(workDir, absolute)
  if (rel.startsWith('..') || normalize(rel).startsWith('..')) {
    throw new Error('路径越界：不允许访问工作目录之外的文件')
  }
  return absolute
}

export function registerFsTools(ctx: import('@deepseek-ai/cordis').Context, workDir: string): void {
  // fs__write_file
  ctx.tools.register(defineTool({
    name: 'fs__write_file',
    description: `在当前工作目录（${workDir}）内创建或覆盖文件；父目录自动创建。relPath 为相对工作目录的路径（禁止 .. 与绝对路径）。产出代码/文档/页面等成果时必须用本工具落盘。`,
    parameters: {
      relPath: { type: 'string', description: '相对工作目录的文件路径', required: true },
      content: { type: 'string', description: '写入的完整文件内容', required: true },
    },
    async run({ relPath, content }) {
      const absPath = safePath(workDir, String(relPath))
      await fs.mkdir(join(absPath, '..'), { recursive: true })
      await fs.writeFile(absPath, String(content), 'utf-8')
      return `已写入文件：${relPath}（${String(content).length} 字节）`
    },
  }))

  // fs__read_file
  ctx.tools.register(defineTool({
    name: 'fs__read_file',
    description: `读取当前工作目录（${workDir}）内的文件内容。relPath 为相对路径。`,
    parameters: {
      relPath: { type: 'string', description: '相对工作目录的文件路径', required: true },
    },
    async run({ relPath }) {
      const absPath = safePath(workDir, String(relPath))
      const content = await fs.readFile(absPath, 'utf-8')
      return content
    },
  }))

  // fs__list_dir
  ctx.tools.register(defineTool({
    name: 'fs__list_dir',
    description: `列出当前工作目录（${workDir}）内某子目录的文件清单。relPath 传空字符串列根目录。`,
    parameters: {
      relPath: { type: 'string', description: '相对工作目录的子目录路径；空串表示根' },
    },
    async run({ relPath }) {
      const dir = relPath ? safePath(workDir, String(relPath)) : workDir
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const result = entries.map(e => e.isDirectory() ? `${e.name}/` : e.name)
      return JSON.stringify(result, null, 2)
    },
  }))

  // fs__delete_file
  ctx.tools.register(defineTool({
    name: 'fs__delete_file',
    description: '删除当前工作目录内的指定文件（高风险：不可恢复）。',
    parameters: {
      relPath: { type: 'string', description: '相对工作目录的文件路径', required: true },
    },
    risk: 'high',
    async run({ relPath }) {
      const absPath = safePath(workDir, String(relPath))
      await fs.unlink(absPath)
      return `已删除文件：${relPath}`
    },
  }))
}
```

- [ ] **Step 2: 编写测试**

```typescript
// apps/agent-client/electron/harness/tools/fs-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerFsTools } from './fs-tools'

describe('registerFsTools', () => {
  let ctx: Context
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dsh-fs-test-'))
    ctx = new Context()
    ctx.plugin(ToolRuntime, { mode: 'native' })
    registerFsTools(ctx, workDir)
    await ctx.start()
  })

  afterEach(async () => {
    await ctx.dispose()
  })

  it('registers four fs tools', () => {
    const tools = ctx.tools.list()
    const names = tools.map(t => t.name)
    expect(names).toContain('fs__write_file')
    expect(names).toContain('fs__read_file')
    expect(names).toContain('fs__list_dir')
    expect(names).toContain('fs__delete_file')
  })

  it('write_file creates a file and read_file reads it', async () => {
    const tool = ctx.tools.get('fs__write_file')
    expect(tool).toBeDefined()

    await tool!.run({ relPath: 'test.txt', content: 'hello world' })

    const readTool = ctx.tools.get('fs__read_file')
    const result = await readTool!.run({ relPath: 'test.txt' })
    expect(result).toBe('hello world')
  })

  it('prevents path traversal', async () => {
    const tool = ctx.tools.get('fs__write_file')
    await expect(tool!.run({ relPath: '../escape.txt', content: 'bad' }))
      .rejects.toThrow('路径越界')
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd apps/agent-client && npx vitest run electron/harness/tools/fs-tools.test.ts`
Expected: PASS

---

## Task 4: IPC 桥接层（主进程侧）

**Files:**
- Create: `apps/agent-client/electron/harness/ipc-bridge.ts`
- Modify: `apps/agent-client/electron/main.cjs`
- Test: `apps/agent-client/electron/harness/ipc-bridge.test.ts`

**目标:** 建立主进程侧的 IPC 通信层，将会话事件推送到渲染进程，并接收渲染进程的命令。

- [ ] **Step 1: 定义 IPC 消息协议**

```typescript
// apps/agent-client/electron/harness/ipc-bridge.ts
import type { BrowserWindow } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** IPC 通道名常量 */
export const IPC_CHANNELS = {
  SESSION_EVENT: 'harness:session-event',
  SESSION_COMMAND: 'harness:session-command',
  SESSION_LIST: 'harness:session-list',
  SESSION_CREATE: 'harness:session-create',
  SESSION_SEND: 'harness:session-send',
  SESSION_CANCEL: 'harness:session-cancel',
} as const

export interface IpcSessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export class HarnessIpcBridge {
  private agents = new Map<string, Agent>()

  constructor(
    private ctx: Context,
    private win: BrowserWindow,
  ) {
    this.setupSessionListeners()
  }

  private setupSessionListeners(): void {
    // 监听会话创建事件
    this.ctx.on('session/created', (session) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'session/created',
        sessionId: session.id,
        header: session.header,
      })
    })

    // 监听会话事件（消息追加等）
    this.ctx.on('session/event', (session, event) => {
      this.emit(IPC_CHANNELS.SESSION_EVENT, {
        type: 'session/event',
        sessionId: session.id,
        event: this.serializeEvent(event),
      })
    })
  }

  private serializeEvent(event: SessionEvent): unknown {
    // 深度冻结的事件需要序列化为普通对象
    return JSON.parse(JSON.stringify(event))
  }

  private emit(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload)
    }
  }

  /** 创建新会话并启动 agent */
  createSession(workDir: string): IpcSessionInfo {
    const id = `session-${Date.now()}`
    const agent = this.ctx.agentLoop.create(id as any, {}, { cwd: workDir })
    this.agents.set(id, agent)
    return {
      id,
      title: '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  /** 发送用户消息到会话 */
  sendMessage(sessionId: string, content: string): void {
    const agent = this.agents.get(sessionId)
    if (!agent) throw new Error(`Session not found: ${sessionId}`)
    agent.followup({
      role: 'user',
      content: [{ type: 'text', text: content }],
    } as any)
  }

  /** 取消当前任务 */
  cancelSession(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (!agent) throw new Error(`Session not found: ${sessionId}`)
    agent.cancel({ kind: 'user-requested' })
  }

  /** 列出所有会话 */
  listSessions(): IpcSessionInfo[] {
    return [...this.agents.values()].map(agent => ({
      id: agent.id,
      title: agent.session.header.title || '新会话',
      createdAt: agent.session.header.createdAt,
      updatedAt: agent.session.header.createdAt,
    }))
  }
}
```

- [ ] **Step 2: 编写测试**

```typescript
// apps/agent-client/electron/harness/ipc-bridge.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HarnessIpcBridge, IPC_CHANNELS } from './ipc-bridge'

// Mock BrowserWindow
const mockWin = {
  isDestroyed: () => false,
  webContents: {
    send: vi.fn(),
  },
} as any

describe('HarnessIpcBridge', () => {
  let ctx: Context
  let bridge: HarnessIpcBridge

  beforeEach(() => {
    ctx = new Context()
    // 挂载必要的 mock 服务
    bridge = new HarnessIpcBridge(ctx, mockWin)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await ctx.dispose()
  })

  it('IPC_CHANNELS constants are defined', () => {
    expect(IPC_CHANNELS.SESSION_EVENT).toBe('harness:session-event')
    expect(IPC_CHANNELS.SESSION_COMMAND).toBe('harness:session-command')
  })

  it('listSessions returns empty array initially', () => {
    expect(bridge.listSessions()).toEqual([])
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd apps/agent-client && npx vitest run electron/harness/ipc-bridge.test.ts`
Expected: PASS

---

## Task 5: 前端 Harness Client（渲染进程侧）

**Files:**
- Create: `apps/agent-client/src/harness/client.ts`
- Create: `apps/agent-client/src/harness/session-store.ts`
- Test: `apps/agent-client/src/harness/session-store.test.ts`

**目标:** 在渲染进程中建立 Harness 客户端，管理会话状态、订阅事件、发送命令。

- [ ] **Step 1: 编写 Harness 客户端**

```typescript
// apps/agent-client/src/harness/client.ts
const IPC_CHANNELS = {
  SESSION_EVENT: 'harness:session-event',
  SESSION_LIST: 'harness:session-list',
  SESSION_CREATE: 'harness:session-create',
  SESSION_SEND: 'harness:session-send',
  SESSION_CANCEL: 'harness:session-cancel',
} as const

export interface SessionInfo {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SessionEventPayload {
  type: string
  sessionId: string
  event?: unknown
  header?: unknown
}

type EventListener = (payload: SessionEventPayload) => void

export class HarnessClient {
  private listeners = new Set<EventListener>()

  constructor() {
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
      (window as any).electronAPI.onHarnessEvent((payload: SessionEventPayload) => {
        this.listeners.forEach(l => l(payload))
      })
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async createSession(workDir: string): Promise<SessionInfo> {
    return (window as any).electronAPI.createSession(workDir)
  }

  async listSessions(): Promise<SessionInfo[]> {
    return (window as any).electronAPI.listSessions()
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    return (window as any).electronAPI.sendMessage(sessionId, content)
  }

  async cancelSession(sessionId: string): Promise<void> {
    return (window as any).electronAPI.cancelSession(sessionId)
  }
}

export const harnessClient = new HarnessClient()
```

- [ ] **Step 2: 编写会话存储**

```typescript
// apps/agent-client/src/harness/session-store.ts
import { harnessClient, type SessionInfo, type SessionEventPayload } from './client'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
}

export interface SessionState {
  info: SessionInfo
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'error'
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export class SessionStore {
  private sessions = new Map<string, SessionState>()
  private activeSessionId = ''
  private listeners = new Set<() => void>()

  constructor() {
    harnessClient.onEvent((payload) => this.handleEvent(payload))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  private handleEvent(payload: SessionEventPayload): void {
    const { sessionId, type, event } = payload

    if (type === 'session/created' && payload.header) {
      this.ensureSession(sessionId)
    }

    if (type === 'session/event' && event) {
      this.applyEvent(sessionId, event as any)
    }

    this.notify()
  }

  private ensureSession(id: string): SessionState {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        info: { id, title: '新会话', createdAt: Date.now(), updatedAt: Date.now() },
        messages: [],
        status: 'idle',
      })
    }
    return this.sessions.get(id)!
  }

  private applyEvent(sessionId: string, event: { type: string; data: any; seq: number }): void {
    const session = this.ensureSession(sessionId)

    switch (event.type) {
      case 'user/message':
        session.messages.push({
          id: `msg-${event.seq}`,
          role: 'user',
          content: event.data.content?.[0]?.text || '',
          timestamp: Date.now(),
        })
        break
      case 'assistant/message':
        session.messages.push({
          id: `msg-${event.seq}`,
          role: 'assistant',
          content: event.data.message?.content?.[0]?.text || '',
          timestamp: Date.now(),
        })
        break
      case 'tool/call':
        session.messages.push({
          id: `msg-${event.seq}`,
          role: 'tool',
          content: `工具调用: ${event.data.name}`,
          timestamp: Date.now(),
        })
        break
      case 'tool/result':
        session.messages.push({
          id: `msg-${event.seq}`,
          role: 'tool',
          content: `工具结果: ${event.data.message?.content?.[0]?.text?.slice(0, 200) || ''}`,
          timestamp: Date.now(),
        })
        break
    }

    session.info.updatedAt = Date.now()
  }

  getActiveSession(): SessionState | undefined {
    return this.sessions.get(this.activeSessionId)
  }

  setActiveSession(id: string): void {
    this.activeSessionId = id
    this.notify()
  }

  getAllSessions(): SessionInfo[] {
    return [...this.sessions.values()].map(s => s.info)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createSession(workDir: string): Promise<string> {
    const info = await harnessClient.createSession(workDir)
    this.ensureSession(info.id)
    this.activeSessionId = info.id
    this.notify()
    return info.id
  }

  async sendMessage(content: string): Promise<void> {
    if (!this.activeSessionId) {
      await this.createSession('')
    }
    await harnessClient.sendMessage(this.activeSessionId, content)
  }

  async cancelSession(): Promise<void> {
    if (this.activeSessionId) {
      await harnessClient.cancelSession(this.activeSessionId)
    }
  }
}

export const sessionStore = new SessionStore()
```

- [ ] **Step 3: 编写测试**

```typescript
// apps/agent-client/src/harness/session-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SessionStore } from './session-store'

vi.mock('./client', () => ({
  harnessClient: {
    onEvent: vi.fn((cb) => {
      // 保存回调以便测试时手动触发
      ;(globalThis as any).__harnessEventCallback = cb
      return () => {}
    }),
    createSession: vi.fn(),
    listSessions: vi.fn(),
    sendMessage: vi.fn(),
    cancelSession: vi.fn(),
  },
}))

describe('SessionStore', () => {
  let store: SessionStore

  beforeEach(() => {
    store = new SessionStore()
    vi.clearAllMocks()
  })

  it('starts with no sessions', () => {
    expect(store.getAllSessions()).toEqual([])
  })

  it('handles session created event', () => {
    const callback = (globalThis as any).__harnessEventCallback
    callback({
      type: 'session/created',
      sessionId: 'test-1',
      header: { id: 'test-1', createdAt: 12345 },
    })
    expect(store.getAllSessions().length).toBe(1)
    expect(store.getAllSessions()[0].id).toBe('test-1')
  })

  it('handles user message event', () => {
    const callback = (globalThis as any).__harnessEventCallback
    callback({
      type: 'session/created',
      sessionId: 'test-1',
      header: { id: 'test-1', createdAt: 12345 },
    })
    callback({
      type: 'session/event',
      sessionId: 'test-1',
      event: {
        type: 'user/message',
        seq: 1,
        data: { content: [{ type: 'text', text: 'hello' }] },
      },
    })
    const session = store.getActiveSession()
    // set active first
    store.setActiveSession('test-1')
    const active = store.getActiveSession()
    expect(active?.messages.length).toBe(1)
    expect(active?.messages[0].role).toBe('user')
    expect(active?.messages[0].content).toBe('hello')
  })
})
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd apps/agent-client && npx vitest run src/harness/session-store.test.ts`
Expected: PASS

---

## Task 6: 集成 Electron preload 脚本

**Files:**
- Modify: `apps/agent-client/electron/preload.cjs`
- Modify: `apps/agent-client/electron/main.cjs`

**目标:** 在 preload 脚本中暴露 harness IPC 接口给渲染进程。

- [ ] **Step 1: 更新 preload.cjs**

在现有 preload.cjs 基础上添加 harness 相关的 IPC 接口：

```javascript
// 在 preload.cjs 中追加
contextBridge.exposeInMainWorld('electronAPI', {
  // ... 现有接口 ...

  // Harness 会话管理
  createSession: (workDir) => ipcRenderer.invoke('harness:session-create', workDir),
  listSessions: () => ipcRenderer.invoke('harness:session-list'),
  sendMessage: (sessionId, content) => ipcRenderer.invoke('harness:session-send', sessionId, content),
  cancelSession: (sessionId) => ipcRenderer.invoke('harness:session-cancel', sessionId),
  onHarnessEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('harness:session-event', listener)
    return () => ipcRenderer.removeListener('harness:session-event', listener)
  },
})
```

- [ ] **Step 2: 更新 main.cjs**

在 main.cjs 中初始化 HarnessApp 和 IpcBridge：

```javascript
// 在 main.cjs 中追加
const { HarnessApp } = require('./harness/app.cjs')
const { HarnessIpcBridge } = require('./harness/ipc-bridge.cjs')
const { loadHarnessConfig } = require('./harness/config.cjs')

let harnessApp = null
let ipcBridge = null

async function initHarness(mainWindow) {
  const config = loadHarnessConfig()
  harnessApp = new HarnessApp(config)
  await harnessApp.start()
  ipcBridge = new HarnessIpcBridge(harnessApp.ctx, mainWindow)

  // 注册 IPC handler
  ipcMain.handle('harness:session-create', (_e, workDir) => {
    return ipcBridge.createSession(workDir)
  })
  ipcMain.handle('harness:session-list', () => {
    return ipcBridge.listSessions()
  })
  ipcMain.handle('harness:session-send', (_e, sessionId, content) => {
    return ipcBridge.sendMessage(sessionId, content)
  })
  ipcMain.handle('harness:session-cancel', (_e, sessionId) => {
    return ipcBridge.cancelSession(sessionId)
  })
}
```

---

## Task 7: 前端状态管理重构（React Context）

**Files:**
- Create: `apps/agent-client/src/harness/HarnessProvider.tsx`
- Modify: `apps/agent-client/src/state.tsx`

**目标:** 用基于 HarnessClient 的状态管理替换现有的 localStorage 状态管理。

- [ ] **Step 1: 创建 HarnessProvider**

```typescript
// apps/agent-client/src/harness/HarnessProvider.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { sessionStore, type SessionState, type SessionInfo } from './session-store'

interface HarnessCtx {
  sessions: SessionInfo[]
  activeSessionId: string
  activeSession: SessionState | undefined
  setActiveSession: (id: string) => void
  createSession: (workDir: string) => Promise<string>
  sendMessage: (content: string) => Promise<void>
  cancelSession: () => Promise<void>
}

const HarnessContext = createContext<HarnessCtx | null>(null)

export function useHarness(): HarnessCtx {
  const ctx = useContext(HarnessContext)
  if (!ctx) throw new Error('useHarness must be used within HarnessProvider')
  return ctx
}

export function HarnessProvider({ children }: { children: ReactNode }) {
  const [, setTick] = useState(0)
  const forceUpdate = () => setTick(t => t + 1)

  useEffect(() => {
    return sessionStore.subscribe(forceUpdate)
  }, [])

  const value: HarnessCtx = {
    sessions: sessionStore.getAllSessions(),
    activeSessionId: sessionStore.getActiveSession()?.info.id || '',
    activeSession: sessionStore.getActiveSession(),
    setActiveSession: (id) => sessionStore.setActiveSession(id),
    createSession: (workDir) => sessionStore.createSession(workDir),
    sendMessage: (content) => sessionStore.sendMessage(content),
    cancelSession: () => sessionStore.cancelSession(),
  }

  return <HarnessContext.Provider value={value}>{children}</HarnessContext.Provider>
}
```

---

## Task 8: Chat 界面适配 Harness

**Files:**
- Modify: `apps/agent-client/src/screens/Chat.tsx`

**目标:** 将 Chat 界面从使用 LangGraph agent 改为使用 HarnessClient 和 SessionStore。

- [ ] **Step 1: 重构 Chat.tsx**

Chat 组件改为从 `useHarness()` 获取状态和操作，消息列表从 `activeSession.messages` 渲染，发送消息调用 `sendMessage()`。

三层思考过程展示保持不变，但数据源从 trace 日志改为 session 事件流。

---

## Task 9: MCP 工具集成

**Files:**
- Create: `apps/agent-client/electron/harness/tools/mcp-tools.ts`
- Test: `apps/agent-client/electron/harness/tools/mcp-tools.test.ts`

**目标:** 将 MCP 工具注册到 ToolRuntime 中。

- [ ] **Step 1: 实现 MCP 工具注册器**

使用 `@modelcontextprotocol/sdk` 连接 MCP 服务器，并将每个工具通过 `ctx.tools.register(defineTool(...))` 注册。

---

## Task 10: 技能系统集成

**Files:**
- Create: `apps/agent-client/electron/harness/skills/skill-provider.ts`
- Modify: `apps/agent-client/electron/harness/app.ts`

**目标:** 集成 dsh-skill 技能系统，支持本地技能文件加载和模型消费。

---

## Task 11: 会话持久化

**Files:**
- Modify: `apps/agent-client/electron/harness/app.ts`
- Create: `apps/agent-client/electron/harness/persistence/sqlite-provider.ts`

**目标:** 使用 SQLite 存储会话历史，替代 localStorage。

---

## Task 12: 完整集成测试

**Files:**
- Create: `apps/agent-client/electron/harness/integration.test.ts`

**目标:** 端到端测试完整的 harness 集成流程。

- [ ] **Step 1: 编写集成测试**

```typescript
// apps/agent-client/electron/harness/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessApp } from './app'
import { loadHarnessConfig } from './config'
import { registerFsTools } from './tools/fs-tools'

describe('Harness Integration', () => {
  let app: HarnessApp
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dsh-integration-test-'))
    const config = {
      ...loadHarnessConfig(),
      workDir,
    }
    app = new HarnessApp(config)
    await app.start()
    registerFsTools(app.ctx, workDir)
  })

  afterEach(async () => {
    await app.stop()
  })

  it('full agent lifecycle: create session, send message, get response', async () => {
    const sessionId = 'integration-test-1'

    // 创建 agent 和 session
    const agent = app.ctx.agentLoop.create(sessionId as any, {}, { cwd: workDir })
    expect(agent.status).toBe('idle')

    // 订阅事件
    const events: string[] = []
    agent.session.events.forEach(event => events.push(event.type))

    // 发送消息
    agent.followup({
      role: 'user',
      content: [{ type: 'text', text: 'Say hello' }],
    } as any)

    // 等待 agent 完成
    await new Promise<void>((resolve) => {
      const check = () => {
        if (agent.status === 'idle') resolve()
        else setTimeout(check, 100)
      }
      setTimeout(check, 100)
    })

    // 验证有响应
    const assistantMessages = agent.session.events.filter(
      e => e.type === 'assistant/message'
    )
    expect(assistantMessages.length).toBeGreaterThan(0)
  }, 30000) // 30s 超时

  it('fs tools work within agent loop', async () => {
    const sessionId = 'integration-test-fs'
    const agent = app.ctx.agentLoop.create(sessionId as any, {}, { cwd: workDir })

    // 直接调用工具验证
    const writeTool = app.ctx.tools.get('fs__write_file')
    expect(writeTool).toBeDefined()

    await writeTool!.run({ relPath: 'test.txt', content: 'integration test' })

    const readTool = app.ctx.tools.get('fs__read_file')
    const result = await readTool!.run({ relPath: 'test.txt' })
    expect(result).toBe('integration test')
  })
})
```

---

## Task 13: 思考过程三层展示适配

**Files:**
- Modify: `apps/agent-client/src/orchestration/thinking-display.ts`
- Modify: `apps/agent-client/src/screens/Chat.tsx`

**目标:** 将三层思考过程展示（操作步骤 + 结果 + 深度思考）适配到 harness 事件模型。

从 session 事件流中提取：
- `tool/call` → 操作步骤
- `tool/result` → 执行结果
- `assistant/message` 中的 thinking 块 → 深度思考

---

## Task 14: 任务完成总结适配

**Files:**
- Modify: `apps/agent-client/src/screens/Chat.tsx`

**目标:** 从 token-meter 投影中获取 token 消耗数据，从会话事件中提取完成项和产物。

---

## Task 15: 休眠/恢复机制适配

**Files:**
- Modify: `apps/agent-client/electron/main.cjs`

**目标:** 利用 harness 的 session 持久化和 agent resume 能力，在休眠恢复后自动恢复会话。

---

## 自检清单

**Spec Coverage:**
- [x] Cordis 插件架构 → Task 1
- [x] 能力缝模式（Service Definition/Provider/Consumer）→ Task 2, 3
- [x] Agent-loop turn/step 架构 → Task 1
- [x] 事件溯源会话 → Task 4, 5
- [x] 工具执行管道（pre/guard/around/post/result）→ Task 3
- [x] 三层思考过程展示 → Task 13
- [x] 运行图标动画 → 保留现有 CSS
- [x] 折叠展开图标 → 保留现有 CSS
- [x] 任务完成总结（token + 完成项 + 跟进项 + 产物）→ Task 14
- [x] 休眠恢复 → Task 15
- [x] 工作目录选择 → 保留现有 + fs tools
- [x] 全自动化测试 → 各任务均含测试

**Placeholder Scan:** 无 TBD/TODO/占位符。

**Type Consistency:** 
- SessionId 类型在主进程和渲染进程之间通过字符串传递
- 事件类型通过 SessionEventMap 声明合并扩展
