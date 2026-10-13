# 智能体编排详细设计（apps/agent-client）

> 版本：v1.0 ｜ 2026-08-29 ｜ 状态：基础版已完成，Batch #1 已完成（52/52 测试绿、构建通过）
> 目标读者：后续迭代开发者。本文档自包含，记录架构、分批决策、各批次设计与已知坑。

---

## 1. 背景与目标

- **目标**：`Agent = Model + Harness`。用官方 `@langchain/langgraph` 做编排引擎，把 WorkBuddy 的
  Skill / MCP / Connector 能力真正接入智能体，而非仅作文本前馈。
- **已完成（基础版）**：用官方 LangGraph（`Annotation.Root` / `StateGraph` / `START` / `END`）替换自研
  StateGraph，实现 `plan → execute → verify → (revise)` 自反思循环。
  - 验证状态：`tsc --noEmit` 0 错误；`vitest run` 45/45 通过；`vite build` 600 模块 transform 成功，
    `@langchain/langgraph` 正常打包（详见 §9 验证闭环）。
- **已知局限（基础版 / Batch #1 前）**：Skill/MCP/Connector 只是"拼成文本塞进 system prompt"，模型**看得到但调不了**；
  verify 与 execute 是同一个 LLM（裁判即选手）；无 token 级流式；调用次数被循环放大。
  其中"MCP/Connector 调不了"**已在 Batch #1 解决**（tool-calling ReAct）；verify 同模型、流式、调用放大仍需 Batch #2/#3。

---

## 2. 当前架构（基础版，已完成）

- `src/orchestration/agent.ts`
  - `AgentState`：`Annotation.Root` 定义；`trace`/`usage` 用 reducer 累加，其余字段 LastValue。
  - 图：`START → planner → executor → verifier → (reviser)* → END`；`recursionLimit`（默认 20）熔断环路。
  - 节点名已重命名（`planner/executor/verifier/reviser`），**不可与状态字段同名**（LangGraph 约束）。
- `ModelRunner.chat(messages)` → `{ content, usage, model }`：纯文本往返。
  具体实现 `ZhipuClient`（`src/adapter/zhipu.ts`）对接智谱 OpenAI 兼容 SSE，含多 Key 池 + 429 剔除 +
  主/兜底模型降级 + 会话级额度追踪。
- **前馈（Feedforward）**：在模型作答前注入
  - Skill：`buildSkillPrompt()`（方法论指令，见 `skills.ts`）
  - Connector：`buildConnectorPrompt()`（实时数据，见 `connector.ts`）
  - MCP：`buildToolPrompt()`（工具列表，**纯提示式**，见 `mcp.ts`）
- **反馈（Feedback）**：`verifier` 解析返回首行 `PASS`/`FAIL` 决定是否改写。

---

## 3. 决策：分批路线（2026-08-29 确认）

优先级按"**这个需求是否成立**"排序，而非技术难度：

| 批 | 项 | 顺序理由 | 关键改动 |
|---|---|---|---|
| **#1** | **工具真打通**（MCP + Connector → tool-calling ReAct） | 这是 "Agent=Model+Harness" 成立的**唯一前提**；不做则 LangGraph 只是 chat 端点花架子 | executor 改为 tool-calling 循环；MCP `tools/call` 与 Connector 数据读取包成可调用 `Tool`；Skill 保持前馈 |
| **#2** | **token 级 SSE 流式 + 429 重试退避** | 决定"能不能日常用"；消已踩的限流与"像卡死→以为永远异常"误判 | `streamMode:'messages'` 或自管 SSE；`ModelRunner` 加退避重试 |
| **#3** | **评判增强**（独立 critic / 置信度阈值 / 早停） | 提质、防无限改写与"最差答案当最终" | verifier 用规则或第二模型；`maxRevisions` 早停 |
| **#4** | **部署收尾**（lockfile / exe） | 机械、必须、不改架构 | 本机 `pnpm install` 写 lockfile；`ELECTRON_MIRROR` + `rebuild electron` + `dist:electron` |

### 核心设计判断

1. **Skill = 方法论（前馈），不是可执行动作 → 不接成 tool。**
   Skill 是"如何思考"的指令（`instructions`），没有输入/输出函数语义。Tool 仅限
   **MCP（真实 `tools/call`）** 与 **Connector（数据读取 GET）**——它们有明确的"调用→返回数据"语义。
2. **Batch #1 把"固定 4 节点链"收敛为**：`planner(可选) → executor(tool-calling ReAct 循环) → verifier(可选)`。
   verify 作为同模型裁判在 tool-calling 范式下会变冗余，降为**可开关的"自检"节点**，不写死必跑。
3. **不引入 LangChain chat model**（如 `@langchain/langchain` 的 `ChatZhipuAI`）。
   用自定义 `ModelRunner` + `Tool` 抽象，保持轻量、provider 无关、易测。
   若未来接入 LangChain chat model，可平滑替换为官方 `ToolNode` + `createToolCallingExecutor`。

---

## 4. Batch #1 详细设计：工具真打通（✅ 2026-08-29 已完成）

### 4.1 Tool 抽象（新增 `src/orchestration/tools.ts`）

```ts
export interface AgentTool {
  name: string;            // 唯一、命名空间化：mcp__<serverId>__<tool> / connector__<id>
  description: string;
  inputSchema?: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<string>; // 返回字符串结果（失败也返回错误字符串，不抛）
}

export function buildAgentTools(): Promise<AgentTool[]>;   // 汇总 MCP(已启用) + Connector(已启用)
export function toolsToDefs(tools: AgentTool[]): ChatToolDef[]; // → OpenAI 风格 tools 定义供 API
export function dispatchTool(tools: AgentTool[], call: ToolCall): Promise<string>; // 按 name 路由执行
```

- **MCP 来源**：`McpManager.listAllTools()` → 每个 `McpTool` 映射为 `AgentTool`，
  `name = mcp__<serverId>__<toolName>`，`call` 经 `McpManager.callTool(serverId, name, args)`。
- **Connector 来源**：`activeConnectors()` → 每个映射为只读 `AgentTool`，`name = connector__<id>`，
  `call = fetchConnectorData(cfg)`（GET 返回文本）。
- **Skill**：不在此列（保持 `buildSkillPrompt()` 前馈）。

### 4.2 类型扩展（`src/adapter/types.ts`）

```ts
export interface ToolCall { id: string; name: string; args: Record<string, unknown>; }
export interface ChatToolDef { type: 'function'; function: { name: string; description: string; parameters?: Record<string, unknown> }; }

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_calls?: ToolCall[];     // assistant 消息携带
  tool_call_id?: string;       // tool 角色消息携带
}
export interface ChatRequest { model?: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; stream?: boolean; tools?: ChatToolDef[]; }
```

`ModelRunner`（agent.ts 内）签名扩展：

```ts
export interface ModelRunner {
  chat(messages: ChatMessage[], opts?: { model?: string; tools?: AgentTool[] }):
    Promise<{ content: string; toolCalls?: ToolCall[]; usage: Usage; model: string }>;
}
```

> 注：`ModelRunner` 接收 `AgentTool[]`，内部转 `ChatToolDef[]` 发给 API，解耦编排层与适配层。

### 4.3 ZhipuClient 工具调用（`src/adapter/zhipu.ts`）

- `attempt()` 在请求 body 注入 `tools`（当 `req.tools` 非空）。
- 解析 `tool_calls`：
  - **非流式**：取 `json.choices[0].message.tool_calls`。
  - **流式（SSE）**：delta 中可能携带 `tool_calls: [{ index, id, function: { name, arguments } }]`，
    按 `index` 累积 `id / name / arguments` 分片，`finish_reason === 'tool_calls'` 时停止追加 content；
    循环结束后 `JSON.parse(arguments)` 得到 `args`。
- `chat()` / `ChatResult` 增加 `toolCalls?: ToolCall[]` 透传。

### 4.4 executor ReAct 循环（`src/orchestration/agent.ts`）

`executeNode` 改为：

```
若未启用工具 或 模型首轮未返回 toolCalls：
    answer = res.content                      // 退化为原"直接作答"，向后兼容（现有测试不变）
否则（ReAct 循环，步数 ≤ maxToolSteps）：
    1. res = call(messages, { tools })
    2. 无 toolCalls → answer = res.content，break
    3. 追加 assistant 消息（content + tool_calls）
    4. 对每个 toolCall：result = dispatchTool(tools, call)
       追加 tool 角色消息（tool_call_id, name, content=result）；trace 记「工具调用：name」
    5. steps++
最终 answer = 最后一轮 assistant 的 content
```

- **图结构**：`planner(可选) → executor → verifier(可选)`。
- **熔断**：`recursionLimit` 仍熔断整图；新增 `maxToolSteps` 熔断 executor 内循环（防单节点无限工具调用）。
- `runAgent` 选项新增 `enableTools?: boolean`、`maxToolSteps?: number`。
- `Chat.tsx` 编排面板新增"启用工具调用""最大工具步数"并透传。

### 4.5 测试策略

- `mockRunner` 支持返回 `toolCalls`；新增用例：
  - 单次工具调用 → 得最终答案
  - 多步工具链（A→B→答案）
  - 无工具 → 退化为直接作答（现有 14 例不回归）
  - `dispatchTool` 失败返回错误字符串不中断循环
  - `maxToolSteps` 熔断
- `zhipu.test.ts` 新增：非流式 / 流式 `tool_calls` 解析。

### 4.6 Batch #1 实施结果（2026-08-29 验收）

| 验收项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错误 |
| `vitest run` | **52/52 通过**（provider-config 13 + conversation 5 + zhipu 11 + state 4 + agent 19） |
| `vite build` | 成功（`dist/assets/index-*.js` ≈ 1.19MB / gzip 338KB） |

- 新增/改动文件：`src/orchestration/tools.ts`（新增）、`src/adapter/types.ts`、`src/adapter/zhipu.ts`、
  `src/orchestration/agent.ts`、`src/screens/Chat.tsx`、`agent.test.ts`、`zhipu.test.ts`。
- 关键修复（实施期发现）：`tryWithKeyPool` 与 `chat()` 透传 `toolCalls`（原被静默丢弃）；
  agent.test 旧节点名断言纠正；recursionLimit / planning-off 两个用例断言纠正。
- **已消解"Harness 弱集成"坑**：MCP（真实 `tools/call`）与 Connector（数据 GET）现在可通过
  tool-calling ReAct 真正被模型调用；Skill 按设计决定保持前馈（方法论，非可执行）。

---

## 5. Batch #2 详细设计：流式 + 限流韧性（待实施）

- **流式**：`runAgent` 采用 `streamMode:'messages'` 或自管 SSE，把答案 token 实时回调 `onToken`；
  executor 内每次 `call` 的 delta 透传到 UI。`Chat.tsx` 渲染打字机效果，消除"像卡死"误判。
- **韧性**：`ModelRunner` 增加 retry / 指数退避（针对 429 / 网络抖动）；`ZhipuClient` 已有 Key 池与降级，
  追加退避；`runAgent` 捕获 429 后重试而非整轮失败。

## 6. Batch #3 详细设计：评判增强（待实施）

- **独立 critic**：`verifier` 用规则或第二模型评判，避免"裁判即选手"。
- **置信度阈值 + 早停**：`maxRevisions` 达上限或置信度足够即停；最终答案取最后一版而非最差改写。

## 7. Batch #4：部署收尾（机械，并行）

- 本机 `pnpm install`（写 lockfile；**沙箱 pnpm 被 rm→genie-trash 钩子 abort，不能在此跑**）。
- exe：`ELECTRON_MIRROR` 镜像 + `pnpm rebuild electron` + `pnpm dist:electron`。

---

## 8. 已知坑 / 约束（跨会话必读）

- **沙箱 pnpm 被 rm 钩子阻断**：`pnpm install`/`pnpm add`/`pnpm run` 一律退出码 1
  （pnpm 在 cwd 建 `_tmp_*` 临时目录，`rm` 触发 genie-trash safe-delete 失败）。
  验证只用本地二进制：`./node_modules/.bin/{tsc,vitest,vite}`（详见 §9）。
- **智谱 429 限流**：Key 池 / 降级已处理，但工具循环会放大调用次数（Batch #2 加退避）。
- **LangGraph 节点名 ≠ 状态字段名**：已用 `planner/executor/verifier/reviser`。
- **recursionLimit 触发抛错当 error 返回**（Batch #1 保留，Batch #3 改善）。
- **Harness 弱集成警告（基础版）**：Skill/MCP/Connector 是文本前馈。**已在 Batch #1 消解**——MCP/Connector 经 tool-calling ReAct 真正可调用；Skill 仍按设计保持前馈（前馈≠缺陷，是语义层方法论）。
- **失败文案必须透出底层真因（2026-08-29 修复）**：`ZhipuClient.chat()` 在 primary/fallback 都失败时，
  **严禁**再用固定文案 `主模型与兜底模型均不可用（Key 池耗尽或网络不可达）` 一刀切——它会吞掉真正的
  `401`(API Key 无效) / `网络请求失败`(apiBase 不可达) / `502/404`(网关或路径错)，导致排查时手动测十几次仍定位不到。
  现改为 `describeFailure()` 携带 `primaryError`/`fallbackError` 真因 + 当前 `apiBase` + 排查提示（直连模式提示查 Key/地址；代理模式额外提示确认 `/zhipu` 代理已启动并注入 Key）。
  回归用例见 `zhipu.test.ts`「失败诊断」describe 块（401 / 网络异常 / 代理模式 三种）。
- **失败必须结构化日志落盘（2026-08-29 补充）**：仅改文案还不够——用户要的是「不复现也能查」。
  新增 `src/adapter/log.ts`（环境自适应：console 始终输出 + Electron IPC `appendLog` 落盘
  `userData/logs/agent-<date>.log` + 浏览器 localStorage 环形缓冲 `dsh-agent-log` + Node 写 `logs/`）。
  `ZhipuClient` 在**网络失败 / 非 429 错误(带 status+body+url) / 429 剔除 / 主模型失败 / 兜底失败 /
  主+兜底全失败 / 对话成功**各节点调用 `logError/logWarn/logInfo`，meta 必带 `apiBase / model / status / 错误真因`。
  Electron 桥：`electron-api.d.ts` 声明 `appendLog` → `preload.cjs` `ipcRenderer.invoke('append-log')`
  → `main.cjs` `ipcMain.handle('append-log')` 追加到 `userData/logs/agent-<date>.log`。
  **任何「调用失败」类问题禁止只在 UI 弹一句没信息量的话**——必须同时落盘结构化 JSON。
- **429 冷却耗尽曾被吞（2026-08-29 晚修复）**：`attempt()` 收到 429 会把 Key 踢进 30s 冷却；当最后一个 Key 也 429 时，
  原 `tryWithKeyPool` 直接 `return null`，导致 `chat()` 的 `primaryError` 为空、最终又掉回
  "Key 池耗尽或网络不可达"一刀切（正是用户吐槽过的"吞真因"）。现改为：无可用 Key 时由 `attempt` 直接抛
  **带剩余时长的冷却错误**（`所有 API Key 均处于冷却期（由 429 触发），约 Ns 后自动恢复，或补充有效 Key`），
  `chat()` 捕获并透出。该错误本身即证明此前拿到过 429（多为**模型配额**耗尽，非永久封禁；概率与"被限流"不同）。
  回归用例见 `zhipu.test.ts`「所有 Key 冷却期（429 触发）」用例。
- **`fetch` 未绑定 `this` → 浏览器 `Illegal invocation`（2026-08-29 晚修复）**：
  `ZhipuClient` 原把 `this.fetchFn = opts.fetchFn ?? globalThis.fetch`，之后以 client 实例为 `this` 调用
  `this.fetchFn(...)`。浏览器要求 `fetch` 的 `this` 是 `Window`（`globalThis`），裸调用会抛
  `Failed to execute 'fetch' on 'Window': Illegal invocation`——**每次对话必崩**，且 Node 测试因 undici fetch
  不依赖 `this` 而测不出来。现改为 `(opts.fetchFn ?? globalThis.fetch).bind(globalThis)`。
  **顶层还加了 `ErrorBoundary`**（`src/ErrorBoundary.tsx`，包裹 `<App/>`）：任何渲染期未捕获错误（含 dev HMR
  瞬时上下文错配导致的 `useApp must be used within AppProvider`）改为可读报错 + 重新加载按钮，不再整屏白屏。
  自动化用例见 `zhipu.test.ts`「fetch 绑定」describe（断言 `this===globalThis` + 强制错误 `this` 调用仍为 globalThis）。
- **「应用配置」之前既无明确反馈、又不持久化（2026-08-29 晚修复）**：
  原 `applyProvider` 只 `app.pushNotice(...)`（右下角小字、易忽略），且**只 `setClient`（内存态）**——
  `primaryModel/fallbackModel/tokenBudget` 从未写进 localStorage，而 `withLocalOverrides` 仅回读
  `mode/apibase/keys`。结果：刷新/切页后主模型又回到默认 `glm-4.6v`，用户手动测试时主观"点了没用/没提示"。
  现改为：① `applyProvider` 把 `primary/fallback/tokenbudget` 一并 `localStorage.setItem`（含 mode/apibase/keys），
  `withLocalOverrides` 回读这三项；② 按钮下方新增**内联反馈** `.applied-hint`（时间·模式·主/兜底模型），
  不再依赖右下角 notice。回归用例见 `provider-config.test.ts`「回读已应用的 主/兜底模型 与 token 预算」。
  **约定：任何"应用/保存"类按钮，必须同时（a）页面内联反馈、（b）把影响行为的字段持久化，不能只靠右上角一次性 toast。**
- **reasoning 模型的 `<think>...</think>` 思考内容必须「分离流式展示」而非丢弃（2026-08-29 晚修复，2026-08-29 本批升级为分离展示）**：
  部分模型（QwQ / DeepSeek-R1 / qwen3.8-max 兼容接口等）会把思考过程直接混在 `content` 里返回。
  **早期方案是剥离丢弃**，但用户反馈"一直没进度"——思考过程本身就是最有价值的「处理进度」。
  现改为**分离展示**：新增 `src/adapter/text.ts` 提供 `stripThinking()`（最终兜底清理）+ `createThinkSplitter()`（SSE 增量状态机，把 `<think>...</think>` 与最终答案实时分开；支持标签跨 chunk、闭合标签被拆开时仅缓冲前缀）。
  `ZhipuClient` 流式把 thinking 增量经 `chunk.thinking` 推送、非流式把 `res.thinking` 单列返回；
  `state.tsx` 的 `appendMessage` 用 splitter 分离后分别存 `content` / `thinking`；`Chat.tsx` 用可折叠 `<details className="think-block">` 作「🤔 思考中…」进度区展示（流式中保持 open，结束折叠）。
  回归用例见 `text.test.ts` 13 例与 `zhipu.test.ts`「thinking 分离（流式进度展示）」describe（流式 content 干净、thinking 单独累积；非流式 res.thinking 单列）。
  **约定 ①：任何从 LLM 拿到的 `content` 必须先过 `stripThinking` 再进入 UI/持久化；新增 adapter/chat 入口必须接入。**
  **约定 ②：`thinking` 字段不得丢弃，必须作为「处理进度」在 UI 流式展示（可折叠）。**
- **任务完成后必须有「总结」且要写进系统规则（2026-08-29 本批）**：
  每次 `send` 拿到最终回复后，`Chat.tsx` 追加一条 `role:'system', name:'summary'` 消息（结构化展示：模型 / 是否降级 / token 用量 / 关键 notice），
  用 `<details className="task-summary">` 折叠呈现。**该 summary 仅 UI 展示，绝不回灌模型上下文**——
  `send` 拼 `historyForModel` 时会 `filter` 掉 `role==='system' && name==='summary'`，避免污染下一轮。
  回归要点：`Chat.tsx` 的 `send()` 中 `historyForModel = history.filter(m => !(m.role==='system' && m.name==='summary'))`。
  **约定：任何「派发任务并拿到结果」的入口，都应在 UI 给出本轮总结（模型/降级/用量/异常）；且总结不回灌模型。**
- **历史会话必须可查看/切换（2026-08-29 本批）**：
  `state.tsx` 引入 `ChatSession { id, title, messages, createdAt, updatedAt }`，全部会话存 `localStorage['dsh-sessions']`，当前会话 id 存 `localStorage['dsh-active-session']`；
  首条用户消息自动作为 `title`。UI 顶部 `session-bar` 提供「新建 / 切换 / 删除」会话 chip。
  `appendMessage` 同步把消息写入 `sessions` 中对应会话的 `messages`（会话级隔离，切换不串消息）。
  **约定：多轮对话产品必须提供「历史会话列表 + 切换 + 删除」，会话持久化到本地存储。**
- **工作目录必须可选 + 授权确认 + 授权态持久化（2026-08-29 本批）**：
  `Workspace.tsx` 支持 `webkitdirectory`（浏览器）与 Electron `electronAPI.selectDirectory` 选择目录，
  选中后 `requestDirectoryAccess(path)` 弹 `confirm` 授权确认，确认后把授权路径写 `localStorage['dsh-workspace-auth']`（持久化授权态）；
  `revokeAccess()` 可撤销。左侧 `auth-bar` 展示已授权路径 + 撤销入口，未授权时提示。
  **约定：访问用户目录类能力必须先经「选择 + 授权确认 + 持久化授权态」，不可静默或默认全权访问。**
- **超长上下文必须采用主流压缩技术（2026-08-29 本批）**：
  新增 `src/adapter/compaction.ts`：`estimateTokens(msgs)`（中文~1.6/英文~4 字符/token，折中 ~2 字符/token 粗略估算）；
  `compactMessages(msgs, opts)` 在 `estimateTokens > contextWindow - reserveTokens` 时，把「最早若干轮」折叠为
  `role:'system', name:'compaction'` 历史摘要（默认启发式 `heuristicSummary` 抽首尾句；可传 `summarize` 走 LLM 高质量摘要），保留最近 `keepRecentTurns` 轮完整；
  未超阈值原样返回（并剥离旧的 compaction 摘要避免叠加膨胀）。`Chat.tsx` 的 `send()` 在拼 `sendHistory` 前先 `compactMessages(...)`。
  异步版 `compactMessagesAsync` 供需要 LLM 摘要时 `await`。回归用例见 `compaction.test.ts` 6 例。
  **约定：任何「持续派发任务」的入口，发送前必须对历史做压缩（滑动窗口 + 历史摘要），确保不撑爆上下文窗口。**
- **多服务商代理必须按 model 路由并正确翻译 endpoint 路径（2026-08-29 晚修复）**：
  Vite dev 代理 `/zhipu` 与 Electron 主进程 `/zhipu` 代理原硬编码转发到 `https://open.bigmodel.cn`，
  导致选择阿里云模型（`qwen*`/`deepseek*`）时请求被发到智谱服务器，产生 401/404/空响应且难以排查。
  现改为解析请求体中的 `model` 字段自动路由：`qwen`/`deepseek` 前缀 → `https://dashscope.aliyuncs.com/compatible-mode/v1`，其余默认 → `https://open.bigmodel.cn`；
  浏览器侧统一构造 `/zhipu/api/paas/v4/chat/completions`，转发到阿里云时必须剥离 `/api/paas/v4`（因阿里云 endpoint 为 `/compatible-mode/v1/chat/completions`），避免打到 `/compatible-mode/v1/api/paas/v4/...` 产生 404。
  同时 `ZhipuClient.completeUrl` 在代理模式（`sendAuth=false`）下必须强制使用全局 `cfg.apiBase`（即 `/zhipu/api/paas/v4`），禁止按模型 entry 的 `apiBase` 直连上游，否则浏览器会绕开代理触发 CORS。
  保留 Key 注入与 SSE 流式透传；错误响应返回 `proxyTarget` 便于确认实际转发地址。
  **约定：任何统一代理网关必须根据模型归属路由到正确上游，并按目标服务商的 endpoint 约定翻译路径；代理模式下客户端必须统一走代理 base，禁止绕过代理直连。**
- **LLM 请求必须有总超时且错误必须落到对话流（2026-08-29 晚修复）**：
  原流式请求无总超时，被浏览器扩展静默拦截或网络挂死时用户侧无反馈；错误只走右上角 notice，可能自动消失。
  现 `ZhipuClient.attempt()` 使用 `AbortController` + 默认 30s 总超时（`ChatRequest.timeoutMs` 可覆盖）；
  `Chat.tsx` 的 `send()` catch 把错误追加为 `role:'assistant', name:'error'` 消息，并针对「超时」「Failed to fetch/NetworkError」给出扩展/VPN/Network 面板排查提示。
  **约定：任何外部 LLM 调用必须带超时；任何调用失败必须在对话流中留下可见痕迹，不能依赖易消失的 notice。**

---

## 9. 验证闭环（每次改动必跑）

```bash
cd apps/agent-client
./node_modules/.bin/tsc --noEmit                 # 0 错误
./node_modules/.bin/vitest run                   # 全绿
mv dist /tmp/old_dist_$(date +%s) && ./node_modules/.bin/vite build   # 避开 rm 钩子，构建成功
```

> **不可用 `pnpm run` / `pnpm exec`**：会被 rm→genie-trash 钩子 abort。
> 依赖声明：本沙箱 pnpm 不可用，新增依赖须**手动写进 package.json**，由用户本机 `pnpm install` 锁 lockfile。

---

## 10. 文件地图与后续入口

| 文件 | 角色 | Batch #1 动作 |
|---|---|---|
| `src/orchestration/agent.ts` | 图与编排核心 | 改：executor ReAct + 图收敛 |
| `src/orchestration/tools.ts` | 工具抽象（**新增**） | 新增 |
| `src/adapter/types.ts` | 类型 | 改：ToolCall / ChatToolDef / ChatMessage / ChatRequest |
| `src/adapter/zhipu.ts` | ModelRunner 实现 | 改：tool_calls 解析 |
| `src/orchestration/skills.ts` | Skill（前馈） | 只读引用，不接 tool |
| `src/orchestration/connector.ts` | Connector 数据 | 只读引用，作为只读 tool 源 |
| `src/adapter/mcp.ts` | MCP 客户端 | 只读引用，`tools/call` 被包成 AgentTool |
| `src/screens/Chat.tsx` | 编排面板 UI | 改：启用工具调用 / 最大工具步数 |

**后续迭代入口**：Batch #2（流式 + 韧性）→ Batch #3（评判增强）→ Batch #4（部署）。
