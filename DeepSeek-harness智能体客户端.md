# deepseek-harness 智能体客户端 · 详细设计文档（V3.7 · 开源本地版）

> **版本**：V3.7  |  **状态**：`Developer Preview（开发者预览版）` 
> **许可**：**开源（Open Source）** · 本地运行（Local-First）  
> **基线**：DeepSeek Harness（`@deepseek-ai/dsh`）官方仓库 + WorkBuddy 使用说明书  
> **UI 参考实现**：高保真交互原型 V2（`prototype/index.html`，单文件零依赖、双击即开），本版三项关键决策（主形态对话居中、Codex 极简黑白配色、成本按每百万 token 单价估算）已在该原型落地，文档 UI 章节与之严格对齐。  
> **重要提示**：当前版本为**开发者预览版**，API、CLI、插件接口在未来版本中**可能发生不兼容变更**，适合技术选型与早期采用。生产环境请锁定版本并关注变更日志。

## 本版定位（V3 核心调整）

**deepseek-harness 是一款完全开源、完全本地运行（Local-First）的智能体客户端。** 据此，本版做出以下关键调整：

- ❌ **移除积分（Credit）系统与付费计费**：本工具为开源免费软件，不存在用量计费、订阅收费、积分消耗等设计。模型调用产生的**实际 API 费用**由用户自行承担（即用户自备各模型厂商的 API Key，直接由本地客户端调用，不经过任何中间计费网关）。
- ✅ **开源属性声明（明确强调）**：本工具是一个**本地优先（Local-First）、完全开源**的 AI 助手客户端。其源代码公开，允许用户**自由使用、修改和分发**，无需向本工具支付任何费用（详见第十二章）。
- ✅ **保留订阅/部署形态说明，但仅作"自部署层级"参考**：Free / Pro / Team 不再代表收费套餐，而是**功能开关层级**（如 Team 层级 = 开启 SSO、组织、审计等企业自部署能力），全部可本地自建，无任何付费门槛。
- ✅ **新增「关于与作者联系」章节**：提供作者 / 维护者联系方式、社区渠道与贡献入口。
- ✅ **第三方模型支持（本次重点）**：统一 Model Provider 体系，原生支持 DeepSeek、OpenAI、智谱 GLM、阿里 Qwen（通义）、百度文心、腾讯混元、Anthropic、Kimi 等，并可通过 `openai-compat` 接入任意自建 / 兼容网关。
- ✅ **长期记忆管理（V3.4 新增）**：新增 5.3 节，定义可展示、可编辑、可遗忘的结构化用户画像记忆系统，全程本地加密存储。
- ✅ **UX 效率工具（V3.4 新增）**：任务批量管理、一键分享、输入框 `@mention`、Markdown 快捷键、通用设置页。
- ✅ **内部一致性自审修复（V3.5）**：对全文进行跨章节一致性审查并修复——恢复遗失的「4.3 多模态内容生成工具集」（与 V3.3 变更记录、附录 A/B 对齐）、统一"成本预估"表述以消除与"无计费"定位的冲突、修正交叉引用（2.1 `pricePer1kInput` → 12.3 `UsageDashboard`）、将第十三章由"Team 及以上"改为"全部层级可用"、同步标题与页眉版本号。详见附录 C「V3.5」。
- ✅ **长期记忆 UI 数据链路修复（V3.6）**：补齐 `memoryHint` 的数据来源——5.3.4 `MemoryRetriever.buildMemoryContext()` 现同时返回 `systemPrompt` 与结构化 `references: MemoryReference[]`（`memoryId` + 摘要），作为 14.2 `memoryHint` 的唯一数据源，消除 UI 字段"无源之水"问题。
- ✅ **成本估算服务统一（V3.6）**：新增 12.3.1 `CostEstimationService`，作为 `estimatedCost` 的唯一计算入口；返回 `CostEstimateResult { kind, display }`，无法估算时显示"费用未知"占位符而非缺失字段，统一 4.3.2、10.2、12.3 三处展示。

**V3.7 原型迭代（高保真原型 V2 落地）**——本版依据原型评审做出三项产品决策，已写入 §14.1 / §14.2 / §12.3 并同步到 `prototype/index.html`：
- ✅ **主形态 = 对话居中**：客户端默认进入「AI 对话（主形态）」（§14.2）；原 §14.1 的 IDE 三栏布局降为「主工作区 · IDE（副形态）」，可从顶栏一键切换。两者共用同一会话与 Agent 运行时。
- ✅ **Codex 极简黑白配色**：UI 设计令牌改为纯黑白灰单色体系（浅色近黑墨 `#0A0A0A` / 深色近白墨 `#F5F5F5`），移除品牌蓝与所有语义彩色（成功绿/告警黄/危险红/记忆紫/引用青），状态仅以文字、描边、灰度深浅区分。
- ✅ **成本按每百万 token 单价配置并估算**：「添加自定义模型」弹窗新增「输入 $/1M · 输出 $/1M」单价字段；用量仪表盘与审批卡按各模型配置单价实时计算 `≈ $金额`，未配置单价的模型显示「费用未知」（沿用 12.3.1 `CostEstimationService`）。

本文档在 V1（WorkBuddy 1:1 功能复刻）基础上，依据《修改意见汇总》系统性升级：

1. **架构升维**：从"功能模块组合"升级为 **「万物皆插件（Everything is a Plugin）」的微内核架构**，以 **Cordis** 为底层框架。
2. **补全产品闭环**：新增部署运行、快速开始、企业级自部署能力、OpenAPI、社区生态。
3. **拥抱真实场景**：新增深度研究工作流、办公连接器、安全审批、合规策略。
4. **模型中立（本次重点）**：抽象出统一的 **Model Provider 体系**，原生支持 DeepSeek、OpenAI、智谱 GLM、阿里 Qwen（通义）、百度文心、腾讯混元、Anthropic 等第三方模型 API，并支持自建 / 兼容端点。


# 〇、设计哲学与核心架构（Architecture）

## 0.1 设计哲学：万物皆插件
系统的唯一第一性原则：**Everything is a Plugin**。
Agent、工具（Tool）、UI 视图、主题、模型适配器（Model Provider）、连接器（Connector）、工作流——**一切功能单元均为可插拔的插件**，微内核本身不绑定任何具体实现。新增能力 = 新增一个插件，无需改动内核。

这带来三大收益：
- **可替换**：换模型、换工具、换 UI，只换插件。
- **可组合**：插件通过 Cordis `Context` / `Service` 声明依赖，自动装配。
- **可分发**：插件可独立发布、版本化、按需安装（插件市场）。


## 0.2 底层框架：Cordis
系统基于 **Cordis** 框架构建。Cordis 提供：服务容器（Service Container）、依赖注入（DI）、插件生命周期管理、可组合的服务上下文。其设计思想参见论文 _A Programming Paradigm for Spatiotemporal Composability_。


```typescript
// 微内核：一切皆为 Plugin，通过 Cordis Context 装配
import { Context, Service } from 'cordis';

class HarnessKernel extends Service {
  constructor(ctx: Context) {
    super(ctx, 'harness');
    // 内置核心服务（本身也是 Plugin）
    ctx.plugin(ModelService);   // 模型适配
    ctx.plugin(ToolService);    // 工具调度
    ctx.plugin(AgentService);   // Agent 运行时
    ctx.plugin(PermissionService); // 权限审批
  }
}

// 任意扩展 = 一个 Plugin，声明依赖即可注入
export function dshPlugin(ctx: Context, config: PluginConfig) {
  const logger = ctx.logger('my-plugin');
  ctx.on('agent/before-call', (e) => { /* ... */ });
  ctx.provide('myService', new MyService(ctx));
}
```


## 0.3 架构分层

```typescript
interface Architecture {
  kernel: {
    cordis: 'Cordis 服务容器 + 依赖注入 + 生命周期';
    pluginLoader: '插件发现 / 依赖解析 / 沙箱隔离';
  };
  corePlugins: {
    modelProvider:  '模型适配器（DeepSeek/OpenAI/智谱/阿里/...）'; // 本次重点
    agentRuntime:   'Agent 编排与协作';
    toolSystem:     '工具注册与调度';
    contextEngine:  '上下文管理';
    streaming:      '流式输出';
    permission:     '安全审批';
  };
  extensionPlugins: {
    connectors: '办公连接器 (Jira/Slack/Notion/...)';
    deepResearch: '深度研究工作流';
    ui: 'UI / 主题插件';
    about: '关于与作者联系';      // 开源本地工具：仅展示信息，无计费
    openapi: 'OpenAPI & SDK';
  };
}
```


# 一、快速开始与部署运行（Quick Start）

## 1.1 运行形态
- **CLI（Headless）**：面向终端 / 自动化，`dsh run "..."`。
- **Web UI**：本地或远程浏览器访问，`dsh web`。
- **IDE 扩展**：VS Code / JetBrains 内嵌。
- **SDK / OpenAPI**：嵌入自有系统。


## 1.2 一键启动（推荐）

```bash
# 无需安装，直接启动 Web UI（npx 自动拉取最新预览版）
npx @deepseek-ai/dsh web

# 指定端口与工作区
npx @deepseek-ai/dsh web --port 8080 --workspace ./my-project
```


## 1.3 从源码构建

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm build
pnpm dsh web          # 启动 Web UI
# 或
pnpm dsh --help       # 查看 CLI
```


## 1.4 配置与运行（CLI / 环境变量）
配置优先级：**CLI 参数 > 环境变量 > `.env` > 默认配置**。

```bash
# .env 示例
DSH_MODEL=deepseek-chat
DSH_MODEL_BASE_URL=https://api.deepseek.com/v1   # 自建 / 第三方端点
DSH_MODEL_API_KEY=sk-xxx

DSH_WORKSPACE=~/projects
DSH_LOG_LEVEL=debug
DSH_OPEN=false            # 启动后不自动打开浏览器（等价于 --no-open）
```

```bash
dsh web --no-open --port 9000 --model openai:gpt-4o
```


# 二、模型 Provider 体系（Multi-Provider Model Layer）【本次重点】
> **目标**：模型中立。内核只面向统一的 `ModelProvider` 接口编程，具体厂商通过**适配器插件**接入，支持任意 OpenAI 兼容端点。


## 2.1 统一接口 ModelProvider

```typescript
// 所有模型厂商实现该接口即可即插即用
export interface ModelProvider<TCfg = any> {
  readonly id: string;            // 'openai' | 'zhipu' | 'aliyun' | 'deepseek' | ...
  readonly displayName: string;
  readonly apiStyle: 'openai-compat' | 'custom'; // 绝大多数厂商走 openai-compat
  configure(cfg: TCfg): void;
  listModels(): ModelInfo[];
  // 核心：统一聊天（含流式 + 工具调用）
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
  embed?(req: EmbedRequest): Promise<EmbedResult>;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ModelInfo {
  id: string;             // 厂商侧模型名，如 'glm-4.5' / 'qwen-plus'
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
  // 成本预估系数（仅用于本地用量仪表盘的 API 费用估算，见 12.3 UsageDashboard.estimatedCost；非本工具计费，非积分扣费。单价为「每百万 token」的 USD，见下方 pricePer1MInput / pricePer1MOutput）
  pricePer1MInput: number;   // 输入单价：美元 / 每百万 token（USD per 1M tokens）
  pricePer1MOutput: number;  // 输出单价：美元 / 每百万 token（USD per 1M tokens）
}
```


## 2.2 内置 Provider 注册表
以下厂商**开箱即用**，均通过 `dsh model add` 或 `.env` 配置 API Key：

| Provider ID | 厂商 | 典型模型 | 接入方式 | 备注 |
|---|---|---|---|---|
| `deepseek` | DeepSeek | `deepseek-chat`, `deepseek-reasoner` | 官方 API / `DEEPSEEK_API_KEY` | 默认模型 |
| `openai` | OpenAI | `gpt-4o`, `gpt-4o-mini`, `o1` | `OPENAI_API_KEY` | 官方 SDK 兼容 |
| `zhipu` | 智谱 AI | `glm-4.5`, `glm-4-plus`, `glm-4v` | `ZHIPU_API_KEY` | 支持工具调用、视觉 |
| `aliyun` | 阿里云（通义千问 / DashScope） | `qwen-plus`, `qwen-turbo`, `qwen-max`, `qwen-vl` | `DASHSCOPE_API_KEY` | OpenAI 兼容端点 |
| `baidu` | 百度（文心一言） | `ernie-4.0`, `ernie-lite` | `BAIDU_API_KEY` + `BAIDU_SECRET_KEY` | 需换取 access_token |
| `tencent` | 腾讯（混元） | `hunyuan-pro`, `hunyuan-standard` | `TENCENT_SECRET_ID` / `SECRET_KEY` | TC3-HMAC-SHA256 签名 |
| `anthropic` | Anthropic | `claude-3-5-sonnet`, `claude-3-opus` | `ANTHROPIC_API_KEY` | Messages API |
| `moonshot` | 月之暗面（Kimi） | `moonshot-v1-128k` | `MOONSHOT_API_KEY` | OpenAI 兼容 |
| `openai-compat` | **任意兼容端点** | 自建 / 第三方网关 | 自定义 `baseURL` + `apiKey` | 见 2.5 |


## 2.3 各厂商适配器要点

### 2.3.1 DeepSeek（默认）

```typescript
ctx.plugin(deepseekProvider, {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
  default: 'deepseek-chat',
});
```


### 2.3.2 OpenAI

```typescript
ctx.plugin(openaiProvider, {
  apiKey: process.env.OPENAI_API_KEY,
  models: ['gpt-4o', 'gpt-4o-mini', 'o1'],
});
```


### 2.3.3 智谱 GLM（ZhipuAI）
智谱 GLM 系列（`glm-4.5` / `glm-4-plus`）原生兼容 OpenAI 接口格式，适配器直接复用 `openai-compat` 客户端，仅需改写 `baseURL` 与鉴权头。

```typescript
// 内部实现：基于 openai-compat，注入智谱专属鉴权
export const zhipuProvider: Plugin = (ctx, cfg) => {
  const client = new OpenAICompatible({
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: cfg.apiKey,                    // ZHIPU_API_KEY
    headerHook: (h) => { h['Authorization'] = 'Bearer ' + cfg.apiKey; },
  });
  ctx.model.register('zhipu', {
    chat: (req) => client.chat(req),
  models: [
    { id: 'glm-4.5', contextWindow: 128000, supportsTools: true, supportsVision: true, pricePer1MInput: 5, pricePer1MOutput: 5 },
    { id: 'glm-4-plus', contextWindow: 128000, supportsTools: true, supportsVision: false, pricePer1MInput: 8, pricePer1MOutput: 8 },
  ],
  });
};
```


### 2.3.4 阿里系（通义千问 / DashScope / Qwen）
阿里系模型通过 DashScope 网关暴露 **OpenAI 兼容端点**，也可走原生 DashScope SDK。支持 Qwen 全系列（含视觉 `qwen-vl`、代码 `qwen-coder`、超大窗 `qwen-long`）。

```typescript
// OpenAI 兼容方式（推荐，零成本适配）
ctx.plugin(openaiCompatProvider, {
  id: 'aliyun',
  displayName: '阿里通义千问 (DashScope)',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
  models: [
    { id: 'qwen-plus',      contextWindow: 131072, supportsTools: true,  pricePer1MInput: 4, pricePer1MOutput: 4 },
    { id: 'qwen-turbo',     contextWindow: 1000000, supportsTools: true,  pricePer1MInput: 2, pricePer1MOutput: 2 },
    { id: 'qwen-max',       contextWindow: 32768,  supportsTools: true,  pricePer1MInput: 20, pricePer1MOutput: 20 },
    { id: 'qwen-long',      contextWindow: 10000000, supportsTools: false, pricePer1MInput: 1, pricePer1MOutput: 1 },
    { id: 'qwen-vl-plus',   contextWindow: 32768,  supportsTools: false, supportsVision: true },
  ],
});
```


### 2.3.5 百度文心（Baidu ERNIE）
文心一言使用自研 API，需通过 `API Key + Secret Key` 换取 `access_token`（适配器自动刷新缓存）。

```typescript
ctx.plugin(baiduProvider, {
  apiKey: process.env.BAIDU_API_KEY,
  secretKey: process.env.BAIDU_SECRET_KEY,
  // 适配器内部: 换取 access_token -> 拼装 ERNIE endpoint
});
```


### 2.3.6 腾讯混元（Tencent Hunyuan）
混元使用 TC3-HMAC-SHA256 签名鉴权，适配器封装签名流程，对外仍暴露统一 `chat()`。

```typescript
ctx.plugin(tencentProvider, {
  secretId: process.env.TENCENT_SECRET_ID,
  secretKey: process.env.TENCENT_SECRET_KEY,
  region: 'ap-guangzhou',
});
```


## 2.4 模型路由与热切换
用户可在对话中**随时切换模型**，也可配置**路由策略**（按任务/成本自动选模型）：

```typescript
interface ModelRouter {
  // 策略：如何为一次请求挑选 provider + model（maxCost 为本地成本上限预估，非硬性计费额度）
  select(task: TaskHint, prefer?: ModelSelection[], maxCost?: number): ModelSelection;
  fallback: ModelSelection[];   // 主模型失败时自动降级
}
// 示例：代码任务优先 DeepSeek，长文档优先 Qwen-Long，视觉任务走 GLM-4V
router.rule({ kind: 'code', prefer: 'deepseek:deepseek-chat' });
router.rule({ kind: 'long-doc', prefer: 'aliyun:qwen-long' });
router.rule({ kind: 'vision', prefer: 'zhipu:glm-4v' });
```


## 2.5 接入"任意"第三方 / 自建模型（OpenAI 兼容端点）
凡实现 OpenAI Chat Completions 协议的端点，均可通过 `openai-compat` 一行接入——**无需写代码**：

```bash
dsh model add my-local \
  --base-url http://localhost:8000/v1 \
  --api-key EMPTY \
  --model my-custom-llm
```
亦可在 `.env` / 配置文件声明：

```json
{
  "models": {
    "openai-compat:my-gateway": {
      "baseURL": "https://your-gateway.example.com/v1",
      "apiKey": "${MY_GATEWAY_KEY}",
      "models": [{ "id": "my-model", "contextWindow": 200000, "supportsTools": true }]
    }
  }
}
```
**校验清单**：`/v1/chat/completions`（流式 SSE）、`/v1/models`、工具调用 `function_call` 格式是否与 OpenAI 一致。不一致时编写**最小转换中间件**即可。


## 2.6 工具调用（Function Calling）标准化
不同厂商的工具调用格式差异由适配器在内部抹平，向上统一为 `ToolCall`：

```typescript
// 内部归一化：把各厂商差异转为统一 ToolCall
export interface UnifiedToolCall {
  id: string;
  name: string;       // 工具名
  arguments: Record<string, unknown>; // JSON 参数（已解析）
}
```
| 厂商 | 原生格式 | 适配处理 |
|---|---|---|
| OpenAI / DeepSeek / 智谱 / 阿里 / Moonshot | `function_call` / `tool_calls` | 直接映射 |
| Anthropic | `tool_use` block | 结构转换 |
| 百度文心 | `plugin` / `functions` | 结构转换 + 名称映射 |


## 2.7 模型配置 UI 与凭据安全
- 设置页「模型」：列出已安装 Provider，支持**添加 / 编辑 / 删除 / 设为默认**。
- API Key 存储于系统 Keychain（macOS Keychain / Windows Credential Manager / Linux Secret Service），**不落明文本地文件**。
- 支持 **代理（HTTP/SOCKS）**、**请求超时**、**重试次数**、**并发上限**配置。
- 企业版支持 **统一模型网关**：个人 Key 由管理员托管，按策略分配配额（见"企业级功能"）。


## 2.8 自定义模型与自定义 API Key 管理【新增，用户侧核心能力】
> 本工具**完全由用户自己掌控模型与凭据**：用户自备任意厂商的 API Key，本地客户端直连厂商端点，工具本身**不内置 Key、不经手 Key、也不代收任何费用**（与"无积分/无计费"定位一致）。本节集中定义自定义模型与 API Key 的完整管理流程。

### 2.8.1 三种添加方式（任一即可）
```typescript
interface CustomModelInput {
  id:          string;   // 用户自定义标识，如 'my-glm' / 'office-gpt'
  provider:    'openai-compat' | 'zhipu' | 'aliyun' | 'baidu' | 'tencent' | 'deepseek' | 'openai' | 'anthropic' | 'moonshot';
  baseURL?:    string;   // 自定义端点（自建网关 / 第三方中转，可留空走厂商默认）
  apiKey:      string;   // 用户自行填写的 API Key（见 2.8.3 安全存储）
  models:      { id: string; contextWindow?: number; supportsTools?: boolean; supportsVision?: boolean }[];
  headers?:    Record<string, string>;  // 额外请求头（如私有网关鉴权）
  proxy?:      string;                  // 可选 HTTP/SOCKS 代理
  // 成本预估单价（每百万 token · USD，可选；用于 §12.3 用量仪表盘。留空则对应模型显示「费用未知」）
  pricePer1MInput?: number;            // 输入单价：美元 / 每百万 token
  pricePer1MOutput?: number;           // 输出单价：美元 / 每百万 token
}
```
1. **图形界面（GUI）**：设置 → 模型 → 「添加自定义模型」，表单填写 `名称 / Provider / 自定义端点(baseURL) / API Key / 模型列表」，实时校验。
2. **命令行（CLI）**：`dsh model add <id> --base-url <url> --api-key <key> --model <name>`（交互式输入 Key，避免写入 shell history）。
3. **配置文件**：`dsh.config.json` 或 `.env`，Key 推荐用环境变量引用（见 2.8.3）。

```bash
# CLI 示例：添加一个自部署的兼容端点（无 Key）
dsh model add local-llm --base-url http://localhost:8000/v1 --model qwen2.5 --api-key EMPTY

# 添加一个智谱兼容 Key（交互式，不回显）
dsh model add my-glm --provider zhipu --api-key
```

### 2.8.2 多 Key 与负载均衡
- 支持为**同一 Provider 配置多个 API Key**（应对厂商额度/限流），运行时按**轮询 / 随机 / 最小剩余配额**自动分发：
```typescript
interface KeyPool {
  provider: string;
  keys: { value: string; quota?: number; lastUsed?: number; disabled?: boolean }[];
  strategy: 'round-robin' | 'random' | 'least-used';
}
```
- 单 Key 触发限流（`429`）或失效（`401`）时**自动剔除并切换下一把 Key**，无需中断对话。

### 2.8.3 API Key 安全存储（凭据隔离）
- **系统 Keychain 优先**：API Key 加密后存入系统凭据管理器（macOS Keychain / Windows Credential Manager / Linux Secret Service / `libsecret`），**绝不写入明文配置文件或日志**。
- **环境变量兜底**：无 Keychain 环境（如纯 CLI/容器）可从 `DSH_KEY_<PROVIDER>` 读取，配置文件中仅写 `${DSH_KEY_ZHIPU}` 占位引用。
- **导入 / 导出**：导出凭据时**强制二次确认 + 仅导出脱敏列表**（默认不导出真实 Key，需显式勾选"含密钥"并明文落盘到用户指定路径）。
- **一键清除**：「清除所有凭据」清空 Keychain 中本工具名下全部条目，便于切换账号或重置。

### 2.8.4 连通性测试与健康检查
添加 / 编辑后立即**自动探测**，避免"配了用不了"：
- `Test Connection`：调用 `/v1/models`（或厂商等价接口）验证 `baseURL + apiKey` 是否合法。
- `Test Chat`：发送一条最小 `chat` 请求，校验模型名、流式、工具调用是否可用。
- 结果显示**耗时、模型列表、错误码与修复建议**（如 `401 → Key 无效`、`403 → 无该模型权限`、`连接超时 → 检查代理/baseURL`）。
```typescript
interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  availableModels?: string[];
  error?: { code: number; message: string; suggestion?: string };
}
```

### 2.8.5 运行时切换
- 对话输入框直接**下拉切换**「Provider : Model」，切换即生效，无需重启。
- 支持**临时覆盖**：本次对话指定 `--model <id>`（CLI）或「仅本次使用」开关，不影响全局默认。
- 模型路由（见 2.4）可按任务自动选模型，并支持"默认走自定义 Key 池"。

> **设计原则**：本节的"自定义模型 / 自定义 API Key"是本工具的**基础能力**（非企业专属），任何用户开箱即可使用；这与本工具"开源、免费、本地运行、凭据自管"的定位完全对齐——**我们不替你保管 Key，也不替你付钱，一切由你掌控**。


# 三、Agent 系统详细设计

## 3.1 多 Agent 架构（插件化）

```typescript
interface AgentSystem {
  // 主 Agent（协调者），本身也是 Plugin
  mainAgent: {
    name: 'Harness';
    role: '协调者';
    responsibilities: ['理解意图', '任务分解', 'Agent 调度', '结果整合', '上下文管理'];
    capabilities: { planning: '规划'; delegation: '委派'; monitoring: '监控'; reporting: '报告'; };
  };
  // 专业 Agent —— 均以 Plugin 形式注册，可按需装卸
  specializedAgents: {
    codeGenerator: { name: 'CodeGen';   expertise: ['生成', '补全', '重构']; supportedLanguages: ['TS','Python','Java','Go','Rust','...']; };
    codeReviewer:   { name: 'ReviewBot'; expertise: ['审查', '质量', '安全']; reviewDimensions: ['正确性','性能','安全','可维护性','风格']; };
    debugger:       { name: 'DebugHelper'; expertise: ['诊断', '性能', '内存']; };
    tester:         { name: 'TestMaster'; testTypes: ['unit','integration','e2e','performance']; };
    documenter:     { name: 'DocWriter';  docTypes: ['apiDocs','readme','comments','changelog']; };
    researcher:     { name: 'DeepResearch'; /* 见"深度研究工作流"章节 */ };
  };
  // 协作机制
  collaboration: {
    communication: { messageQueue: '消息队列'; sharedContext: '共享上下文'; eventBus: '事件总线'; };
    coordination:  { taskDistribution: '任务分配'; resourceAllocation: '资源'; conflictResolution: '冲突解决'; };
    monitoring:    { agentStatus: '状态'; performance: '性能'; errorTracking: '错误'; };
  };
}
```


## 3.2 Agent 工作流程

```typescript
interface AgentWorkflow {
  taskIntake:       { userInput; intentRecognition; contextGathering; taskValidation; };
  taskDecomposition:{ subtaskCreation; dependencyAnalysis; priorityAssignment; resourceEstimation; };
  taskExecution:    { agentSelection; parallelExecution; sequentialExecution; progressTracking; };
  resultIntegration:{ outputCollection; qualityCheck; conflictResolution; finalAssembly; };
  feedbackLoop:     { userFeedback; performanceAnalysis; modelUpdate; strategyAdjustment; };
}
```


# 四、工具系统详细设计

## 4.1 内置工具集

```typescript
interface ToolSystem {
  fileTools: { readFile; writeFile; createFile; deleteFile; moveFile; searchFiles; };
  codeTools: { executeCode; /* 沙箱执行 */ formatCode; analyzeCode; refactorCode; };
  networkTools: { webSearch; fetchUrl; apiRequest; };
  databaseTools: { queryDatabase; manageDatabase; };
  gitTools: { gitStatus; gitDiff; gitCommit; gitBranch; gitPush; };
}
```


## 4.2 自定义工具 & 工具插件

```typescript
interface ToolPlugin {
  manifest: { id; name; version; author; description; dependencies; };
  lifecycle: { install; activate; deactivate; uninstall; update; };
  api: { registerTool; registerAgent; registerUI; getContext; executeCommand; };
}
```


## 4.3 多模态内容生成工具集（Multimodal Generation Tools）【V3.3 新增】
> **定位**：提供图片生成与编辑、视频生成、以及基于研究内容的演示文稿（PPT）自动生成能力。所有功能均以**插件工具（Tool）** 的形式提供给 Agent 调用，并依赖用户已配置的、支持相应多模态能力的模型 Provider（如 OpenAI、智谱 GLM、阿里通义等）。遵循**插件化架构**与**本地运行、用户自备 Key** 原则——工具本身不内置任何模型额度，仅作本地编排。

### 4.3.1 图片生成与编辑工具（ImageGen）

```typescript
interface ImageGenTool {
  generateImage: {
    name: 'generate_image';
    description: '根据文本描述生成一张图片。';
    parameters: {
      prompt: string;          // 必填，详细、正向的图片描述
      negativePrompt?: string; // 可选，反向提示词
      size?: '1024x1024' | '1024x1792' | '1792x1024' | '720x1280'; // 默认 1024x1024
      style?: 'vivid' | 'natural' | 'anime' | 'photographic';       // 风格预设
      n?: number;              // 生成数量，默认 1，最大 4
      model?: string;          // 可选，指定具体模型如 'dall-e-3'、'cogview-3'、'flux'，由 2.4 模型路由决定
    };
    returns: { urls: string[]; revisedPrompt?: string }; // 本地或临时存储路径；模型优化后的提示词
  };
  editImage: {
    name: 'edit_image';
    description: '基于已有图片生成变体，或通过指令进行局部编辑（如换背景、改颜色）。';
    parameters: { image: string; prompt: string; mask?: string; size?: string };
    returns: { url: string };
  };
}
```
- **UI/UX**：对话中以卡片展示生成图片，提供**下载、复制、插入编辑器**按钮；上传图片 + 指令编辑时展示进度条。

### 4.3.2 视频生成工具（VideoGen）

```typescript
interface VideoGenTool {
  generateVideo: {
    name: 'generate_video';
    description: '根据文本描述生成一段短视频。注意：此操作耗时较长，且成本较高。';
    parameters: {
      prompt: string;                  // 必填，视频内容描述
      duration?: 5 | 10 | 15;          // 时长（秒），默认 5
      resolution?: '720p' | '1080p';   // 默认 720p
      aspectRatio?: '16:9' | '1:1' | '9:16';
      model?: string;                   // 如 'sora'、'kling'、'cogvideo'
    };
    returns: { videoUrl: string; thumbnailUrl?: string; estimatedCost: CostEstimateResult }; // estimatedCost 由 12.3.1 CostEstimationService 统一计算，永远有 display（金额或"费用未知"）
  };
}
```
- **高风险审批**：视频生成成本高、耗时长，调用前**必须**弹出 10.2 节「手动审批」卡，清晰展示预估费用和耗时（成本由 12.3.1 `CostEstimationService` 统一计算，见 `ApprovalRequest.preview.estimatedCost`）。
- **UI/UX**：生成期间显示进度，完成后以视频播放器展示，支持下载。

### 4.3.3 演示文稿（PPT）生成工具（PPTGenerator）

```typescript
interface PPTGeneratorTool {
  generatePresentation: {
    name: 'generate_presentation';
    description: '根据主题或详细内容大纲，生成一份专业的演示文稿（.pptx 或 .pdf）。先组织内容结构，再选择页面布局。';
    parameters: {
      topic: string;                        // 必填，如 "2026 AI 行业趋势报告"
      detailContent?: string;               // 可选，用户提供的详细内容、要点或数据
      style?: 'professional' | 'creative' | 'minimal' | 'academic'; // 视觉风格
      slideCount?: number;                  // 目标页数，默认 8-12
      includeCharts?: boolean;              // 是否根据数据生成图表，默认 true
      outputFormat?: 'pptx' | 'pdf';        // 默认 pptx
    };
    returns: { filePath: string; slidePreviews?: string[] };
  };
}
```
**内部实现与工作流：**
1. **内容生成**：由 Agent（如 DeepResearch）根据 `topic` + `detailContent` 生成结构化大纲（标题、每页要点、图表数据）。
2. **布局与设计**：将内容映射到选定 `style` 的幻灯片布局（通过提示工程或本地设计引擎）。
3. **文件生成**：使用 `pptxgenjs`（Node）或 `python-pptx`（Python）在本地生成 `.pptx`，或用无头浏览器渲染为 `.pdf`。
- **与深度研究打通**：DeepResearch 工作流完成后可直接提供「**生成 PPT 报告**」快捷按钮（见 7.2），复用研究报告结构化大纲，避免重复生成。

### 4.3.4 多模态 Provider 适配矩阵
多模态工具通过 `model` 参数交由 **2.4 模型路由**分发，下表为常见映射（端点/价格以各厂商官方为准）：

| 能力 | 推荐 Provider | 典型模型 | 适配方式 |
|---|---|---|---|
| 图片生成 | `openai` | `dall-e-3` | 原生 |
| 图片生成 | `zhipu` | `cogview-3` | openai-compat |
| 图片生成 | `aliyun` | 通义万相（Wanx） | DashScope SDK / openai-compat |
| 视频生成 | `openai` | `sora` | 原生 |
| 视频生成 | `zhipu` | `cogvideo` | openai-compat |
| PPT 内容 | `deepseek` / `openai` / `aliyun` | `deepseek-chat` / `gpt-4o` / `qwen-plus` | 任意文本模型 |

### 4.3.5 产物管理
图片、视频、PPT 均视为**任务产物（Artifact）**，遵循统一的产物生命周期：可被预览、下载、归档、分享（见 14.2.3 产物分享）、插入编辑器。多模态调用前由 10.2 审批卡展示成本（**由 12.3.1 `CostEstimationService` 统一计算，本地成本预估，仅供用户决策，非本工具收费**；无法估算时显示"费用未知"）。


# 五、上下文管理系统

## 5.1 上下文管理

```typescript
interface ContextManagement {
  contextTypes: { conversation; file; project; environment; user; };
  contextStorage: {
    shortTerm: { type: '短期'; capacity: '最近10轮'; storage: '内存'; ttl: '30分钟'; };
    longTerm:  { type: '长期'; capacity: '无限制'; storage: '数据库'; ttl: '永久'; };
    working:   { type: '工作'; capacity: '当前任务'; storage: '内存'; ttl: '任务结束'; };
  };
  managementStrategies: { summarization; compression; prioritization; pruning; caching; };
  windowManagement: { tokenCounting; windowSize; overflowHandling; contextInjection; };
}
```


## 5.2 智能上下文构建

```typescript
class ContextBuilder {
  async collectContext(request: ContextRequest): Promise<Context> {
    return this.optimizeContext({
      conversationHistory: await this.getConversationHistory(request.sessionId),
      relatedFiles:        await this.findRelatedFiles(request.currentFile),
      projectStructure:    await this.getProjectStructure(),
      dependencies:        await this.getDependencies(),
      gitStatus:           await this.getGitStatus(),
      environment:         await this.getEnvironmentInfo(),
      userPreferences:     await this.getUserPreferences(),
    });
  }
  private optimizeContext(context: Context): Context {
    const tokenBudget = this.calculateTokenBudget();
    const priorities = { conversationHistory: 0.4, relatedFiles: 0.3, projectStructure: 0.1, dependencies: 0.1, gitStatus: 0.05, environment: 0.03, userPreferences: 0.02 };
    return this.allocateTokens(context, tokenBudget, priorities);
  }
}
```


## 5.3 长期记忆管理与编辑（Long-Term Memory）【V3.4 新增】

> 长期记忆是系统为用户**持久化存储**的个人信息、偏好、习惯和过往重要结论的能力。它不同于对话历史（短期上下文），是**结构化的、可被用户直接查看和编辑的"用户画像"**。所有记忆**仅存于本地加密数据库**（见 11.2），永不自动上传；云同步时采用端到端加密。

### 5.3.1 记忆类型与数据模型

```typescript
// 长期记忆数据模型
interface LongTermMemory {
  id: string;                          // 唯一标识
  type: 'fact' | 'preference' | 'habit' | 'conclusion' | 'summary';
  content: string;                     // 记忆内容，如 "用户偏好使用 Python"、"项目 X 的核心架构是微服务"
  source: string;                      // 来源，如 "conversation:abc123" 或 "user_input" 或 "manual"
  confidence: number;                  // 置信度 0-1，系统自动评估
  tags?: string[];                     // 标签，便于检索（如 "language"、"project-x"）
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;                   // 最后被引用的时间，用于遗忘策略
  expiryDays?: number;                 // 可选：自定义有效期（天），到期后归档
}
```

| 类型 (`type`) | 含义 | 示例 |
|---|---|---|
| `fact` | 客观事实 | "用户在 A 公司任职后端工程师" |
| `preference` | 主观偏好 | "用户偏好简洁的代码风格" |
| `habit` | 习惯/惯例 | "用户习惯用 TypeScript 写前端" |
| `conclusion` | 对话中达成的重要结论 | "项目 X 决定采用微服务架构" |
| `summary` | 对话/文档的压缩摘要 | "2026-01 会话总结：完成了鉴权模块设计" |

### 5.3.2 核心功能设计

| 功能 | 描述 | 操作方式 |
|---|---|---|
| **自动提取与存储** | Agent 在对话中自动识别并提取值得长期记忆的信息（如"我是后端工程师"、"我喜欢简洁的代码"），写入长期记忆库。 | 系统后台自动执行，可在设置中开启/关闭（`memory.autoExtract`） |
| **记忆展示** | 在"设置"或独立的"记忆"面板中，以列表或卡片形式展示所有长期记忆条目。 | 按类型、时间、相关性排序；支持搜索 |
| **手动编辑** | 用户可修改已有记忆的内容、类型、标签或置信度。 | 点击条目进入编辑模式，内联修改后保存 |
| **手动新增** | 用户可直接添加新的记忆条目，如"项目 X 的数据库密码是 xxx"。 | 在记忆管理界面点击"新增"按钮，弹出表单 |
| **手动删除** | 用户可删除不再适用或错误的记忆条目。 | 提供"删除"按钮，删除时需**二次确认** |
| **记忆遗忘/过期策略** | 系统根据 `lastUsedAt` 或用户设定的"有效期"，自动标记或清理过时信息。 | 设置中可配置"自动遗忘"策略（如 3 个月未使用则归档） |
| **隐私与安全** | 所有长期记忆均仅存储在本地加密数据库（见 11.2 SQLCipher），永不自动上传；云同步时采用端到端加密。 | — |
| **对话中引用记忆** | Agent 在回答用户问题时，会自动检索相关长期记忆作为上下文。检索结果一方面注入系统提示词，另一方面以 `MemoryReference[]`（`memoryId` + 摘要）的形式传递给 UI 层，用于渲染 14.2 节的 `memoryHint`（"⚡ 基于记忆：…"，含可跳转的记忆来源）。 | 系统自动执行；可在记忆面板查看每条的 `lastUsedAt` 与被引用次数（`references` 的数据来源详见 5.3.4） |

### 5.3.3 自动提取流程

```typescript
// 记忆提取器：在每轮对话结束后，由 MemoryExtractor 异步分析
class MemoryExtractor {
  async extractFromConversation(
    conversation: Conversation,
    existingMemories: LongTermMemory[]
  ): Promise<LongTermMemory[]> {
    // 1. 让模型判断本轮对话中是否有值得记忆的信息
    const candidates = await this.llm.invoke({
      model: 'deepseek:deepseek-chat',  // 可由模型路由选择低成本模型
      prompt: MEMORY_EXTRACTION_PROMPT,
      messages: conversation.recentTurns(4),
    });
    // 2. 去重/合并：与已有记忆比对，避免重复写入
    return this.dedupeAndMerge(candidates, existingMemories);
    // 3. 写入本地加密数据库（异步，不阻塞对话）
  }
}
```

- 提取默认**异步、低优先级**执行，不阻塞用户当前对话。
- 提取开关：`settings.memory.autoExtract`（默认 `true`），用户可一键关闭。
- 敏感信息（如密码、Token）默认**不自动提取**，由敏感词规则 + 可选模型判定双重过滤。

### 5.3.4 检索与注入（对话时自动引用）

```typescript
// 被引用记忆的结构化引用（供 UI 层渲染 memoryHint，见 14.2）
interface MemoryReference {
  memoryId: string;   // 对应 LongTermMemory.id
  type: LongTermMemory['type'];  // 记忆类型（fact/preference/habit/conclusion/summary）
  content: string;    // 摘要内容（过长时截断，默认 ≤ 60 字符）
  score?: number;     // 检索相关性得分（0-1），仅内部排序用
}

class MemoryRetriever {
  async retrieveRelevant(query: string, topK = 5): Promise<LongTermMemory[]> {
    // 1. 语义检索（向量）+ 关键词检索（标签/内容）混合
    const semantic = await this.vectorSearch(query, topK);
    const keyword  = await this.tagSearch(query, topK);
    return this.rerankAndMerge(semantic, keyword, topK);
  }

  // 在 ContextBuilder（5.2）中被调用：同时产出"注入系统提示词的文本"
  // 与"供 UI 渲染的结构化引用列表"，二者来自同一次检索，保证一致。
  async buildMemoryContext(query: string): Promise<{
    systemPrompt: string;       // 注入到系统提示词的文本
    references: MemoryReference[];  // 供 UI 层渲染 memoryHint（见 14.2）
  }> {
    const memories = await this.retrieveRelevant(query);
    const systemPrompt = memories
      .map(m => `- [${m.type}] ${m.content}`)
      .join('\n');
    const references = memories.map(m => ({
      memoryId: m.id,
      type: m.type,
      content: m.content,
    }));
    return { systemPrompt, references };
  }
}
```

- **数据流向（关键，消除 UI 字段"无源"问题）**：`AgentRuntime` 在每轮对话调用 `MemoryRetriever.buildMemoryContext()` → 得到 `{ systemPrompt, references }` → `systemPrompt` 注入系统提示词，`references` 随本轮 `assistantMessage` 一起返回 UI 层 → UI 据此渲染 14.2 节定义的 `memoryHint` 字段（`memoryId` 用于点击跳转至对应记忆条目）。**`memoryHint` 的唯一数据来源即此处的 `references`**，除本次检索结果外无其他写入路径。
- 若本轮未检索到相关记忆，`references` 为空数组，`memoryHint` 不渲染——UI 不展示任何"基于记忆"提示。
- 检索结果在对话中以小字标注：**"⚡ 基于记忆：[偏好] 用户偏好 TypeScript"**，点击可跳转至对应记忆条目。
- 每条记忆的 `lastUsedAt` 在被引用时自动更新，影响其遗忘优先级。

### 5.3.5 遗忘/归档策略

```typescript
interface ForgettingPolicy {
  enabled: boolean;          // 是否启用自动遗忘（默认 true）
  maxAgeDays: number;        // 最大保留期，默认 180 天（半年）
  unusedGraceDays: number;   // 未使用宽限期，默认 90 天
  minConfidence: number;     // 低于此置信度的记忆优先清理，默认 0.3
  action: 'archive' | 'delete';  // 到期动作：归档（保留但不再检索）或彻底删除
}
```

- 归档的记忆**不再参与检索**，但仍可在记忆管理面板查看和恢复。
- 遗忘策略在设置页可配置，支持"永不自动遗忘"选项（需用户手动管理）。

### 5.3.6 UI/UX 设计要点

- **入口**：在**设置页面（Settings）** 中新增"**长期记忆 (Memory)**"或"**个人画像**"标签页；亦可在左侧边栏提供快捷入口。
- **主视图**：以清晰的时间线或分类列表展示所有记忆。每条记忆卡片显示**内容、类型标签、置信度、最后更新时间**。
- **编辑与删除**：鼠标悬停或右键点击卡片出现操作按钮（编辑 ✏️ / 删除 🗑️）。删除需二次确认弹窗。
- **搜索与筛选**：顶部提供搜索框，并按"类型"或"时间段"进行筛选。
- **手动添加**：页面显著位置放置"**+ 添加记忆**"按钮，点击后弹出表单窗口（类型/内容/标签/有效期）。
- **系统提示**：在对话中，如果 Agent 使用了记忆，可在其回复内容下方以较小字体显示"⚡ 基于记忆：关于您的项目偏好…"，点击可跳转到对应记忆条目。
- **导入/导出**：支持将记忆以 JSON 格式批量导入/导出（脱敏选项），便于迁移或备份。

> **设计原则**：长期记忆是**用户完全可控**的数据——可查看、可编辑、可删除、可禁用。它仅服务于提升本地使用体验，不涉及任何远端同步或服务（除非用户主动启用云同步，此时采用端到端加密）。


# 六、响应式流式输出系统

## 6.1 流式输出设计

```typescript
interface StreamingSystem {
  streamTypes: { tokenStream: 'Token级'; chunkStream: '块级'; messageStream: '消息级'; toolStream: '工具调用'; };
  streamProcessing: { buffering; throttling; batching; cancellation; };
  renderOptimization: { virtualScrolling; incrementalRender; debounceRender; requestAnimationFrame; };
}
class StreamingResponse {
  private buffer: string[] = [];
  private renderTimer: NodeJS.Timeout | null = null;
  handleStreamChunk(chunk: StreamChunk): void { this.buffer.push(chunk.content); this.scheduleRender(); }
  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.flushBuffer(); this.renderTimer = null; }, 16); // 60fps
  }
  private flushBuffer(): void { const content = this.buffer.join(''); this.buffer = []; this.updateUI(content); }
}
```


# 七、深度研究（Deep Research）工作流【新增】
Deep Research 是一个**专门的 Agent 插件**，面向"需要多源检索 + 交叉验证 + 结构化报告"的复杂任务。

## 7.1 流程

```typescript
interface DeepResearchWorkflow {
  understand:   '理解需求 → 提取研究问题、范围、约束';
  plan:         '规划检索策略 → 拆解子问题、选定检索源与模型';
  retrieve:     '多源并行检索（Web / 学术 / 数据库 / 连接器）';
  crossVerify:  '交叉验证 → 对关键结论至少 2 个独立来源印证';
  synthesize:   '综合分析 → 提炼洞察、识别分歧';
  report:       '生成结构化报告（含图表、竞品矩阵、策略建议）';
  present:      '进度展示 → 实时回传每一步状态与引用';
}
```


## 7.2 进度与引用
- UI 侧实时展示阶段进度条：`规划 → 检索 → 验证 → 写作`。
- 每个结论**内嵌可追溯引用**（来源 URL、访问时间、可信度评分）。
- 报告产物：Markdown + 图表（Mermaid / 表格），支持一键导出 PDF / Word。
- 可选**调用模型 Provider 的策略建议**（见"模型路由"）：事实检索用低成本长窗模型，综合推理用高性能模型。


# 八、连接器与办公应用集成（Connectors）【新增】
连接器 = 一组 **ToolPlugin + 认证（OAuth2）** 的组合，统一遵循 `Connector` 规范，打通办公生态。

```typescript
interface Connector {
  id: string;                // 'jira' | 'slack' | 'notion' | ...
  auth: 'oauth2' | 'pat' | 'service-account';
  tools: ToolDefinition[];   // 暴露给 Agent 的工具（如 jira.createIssue）
  setup(): Promise<void>;    // OAuth 授权流
}
```

| 连接器 | 典型工具 |
|---|---|
| **Jira / Linear** | 创建/查询 Issue、更新状态、关联 PR |
| **Slack** | 发消息、频道检索、@机器人触发 Agent |
| **Notion / Confluence** | 读写页面、检索知识库 |
| **GitHub / GitLab** | Issue/PR、代码评审、Release |
| **Google Drive** | 读写文档（Docs）、表格（Sheets）、幻灯片（Slides）、文件管理（创建/移动/分享/搜索）、评论 |
| **Office 365** | 读写 Word（.docx）、Excel（.xlsx）、Outlook 邮件（发送/检索/草稿）、OneDrive 文件管理、Teams 消息 |
| **腾讯文档** | 读写在线文档/表格、评论协作、文件夹管理、分享链接 |
| **数据库 / SaaS** | 通用 SQL / REST 数据源 |

连接器与**模型 Provider**共享同一插件契约——例如 Agent 可调用 `slack.send` + `deepresearch.report`，再经 `notion.write` 归档，全程受权限审批管控。


# 九、插件系统（插件化微内核）【升级为核心架构】
插件是系统**唯一的扩展方式**，接口与 Cordis `Context` / `Service` / `Plugin` 对齐。

## 9.1 插件架构

```typescript
interface PluginSystem {
  pluginTypes: { tool: '工具'; agent: 'Agent'; ui: 'UI'; theme: '主题'; integration: '连接器'; model: '模型 Provider'; workflow: '工作流'; };
  pluginInterface: {
    manifest: { id; name; version; author; description; dependencies; /* Cordis peerDeps */ };
    lifecycle: { install; activate; deactivate; uninstall; update; };
    api: { registerTool; registerAgent; registerUI; registerModel; getContext; executeCommand; };
  };
  pluginManager: { discovery; installation; dependencyResolution; conflictDetection; sandboxing; marketplace; };
}
```


## 9.2 插件生命周期（Cordis 对齐）

```typescript
// 标准插件骨架：声明依赖的服务，由 Cordis 注入
export const myPlugin: Plugin = (ctx: Context, config: Config) => {
  ctx.on('ready',        () => ctx.logger('my').info('activated'));
  ctx.on('agent/before-call', filter);
  ctx.on('dispose',      () => cleanup());
  ctx.provide('myService', new MyService(ctx));
};
```


# 十、安全、权限与合规系统【强化】

## 10.1 权限管理

```typescript
interface PermissionSystem {
  permissionLevels: { readOnly; write; execute; network; system; };
  permissionControl: {
    filePermissions:      { readPaths; writePaths; executePaths; blockedPaths; };
    commandPermissions:   { allowedCommands; blockedCommands; requireApproval; };
    networkPermissions:   { allowedDomains; blockedDomains; proxySettings; };
  };
  approvalFlow: { autoApprove; manualApprove; approvalTimeout; approvalHistory; };
}
```


## 10.2 高风险操作「手动审批」（Manual Approve）【新增】
文件删除、代码执行、Git 推送、外部 API 调用等**高风险操作**，**默认需用户手动确认**。UI 弹出审批卡，含"允许 / 仅本次 / 拒绝 / 始终允许"按钮，并展示完整参数预览。

```typescript
interface ApprovalRequest {
  toolCall: UnifiedToolCall;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  preview: { command?; fileDiff?; networkRequest?; estimatedCost: CostEstimateResult };  // estimatedCost 由 12.3.1 CostEstimationService 统一计算（永远含 display：金额或"费用未知"）
  actions: ['allow-once', 'allow-always', 'deny', 'edit-params'];
}
```

审批策略可由**企业管理员**集中配置：例如 `git:push` 在 Team 版强制 `manual`，个人版可设为 `auto`。


## 10.3 合规性考量【新增】
- 预留**合规策略配置接口**，可按地区/租户启用不同策略：
  - **EU AI Act**：高风险操作记录、可解释性声明、数据最小化。
  - **中国《生成式人工智能服务管理暂行办法》**：内容安全过滤、备案、个人信息保护。
  - **跨境数据合规**：数据驻留区域（Data Residency）、跨境传输审批、境内/境外模型路由分离。
- 审计日志（Audit Log）全量记录：谁、何时、调用何模型/Agent/工具、输入输出摘要、审批结果。**企业版支持审计日志导出与 SIEM 对接**。


# 十一、数据持久化设计【完善】

## 11.1 存储架构

```typescript
interface DataPersistence {
  storageTypes: { localStorage; indexedDB; sqlite; cloudSync; };
  dataModels: { conversations; projects; agents; tools; settings; auditLogs; credentials; };
  syncStrategies: { realTime; periodic; manual; conflictResolution; };
}
```


## 11.2 本地路径与加密【新增】
| 项目 | 默认路径 | 说明 |
|---|---|---|
| 工作区数据 | `~/.dsh/workspace/` | 项目索引、缓存 |
| 本地数据库 | `~/.dsh/data/harness.sqlite` | **SQLCipher 加密**（key 来自系统 Keychain） |
| 凭据 | 系统 Keychain | API Key、OAuth Token，不落明文 |
| 日志 / 审计 | `~/.dsh/logs/`、`~/.dsh/audit.log` | 审计日志可配置上报 |


## 11.3 云同步（Cloud Sync）【新增，企业级】
- 端到端加密（E2EE）：同步前以用户密钥加密，**服务端不可解密**。
- 支持跨设备恢复：对话、配置、插件列表、授权。
- 冲突解决：基于 CRDT / 最后写入获胜（LWW）可配置。


# 十二、开源发布、功能层级与关于【调整】

> **本节为本版（V3）核心调整章节**：本工具为**完全开源、完全免费、本地运行**的智能体客户端，**不内置任何积分、计费、订阅收费系统**。模型调用所产生的实际 API 费用由用户自行承担（用户自备各模型厂商 API Key，本地客户端直连调用）。以下"层级"仅代表**功能开关层级**，全部可本地自建，无任何付费门槛。

**项目属性明确声明：** 本工具是一个**本地优先（Local-First）、完全开源**的 AI 助手客户端。其源代码公开，允许用户**自由使用、修改和分发，无需向本工具支付任何费用**——这既是产品定位，也是贯穿本设计文档（许可、商业形态、数据处理、分发方式）所有相关章节的基本前提。

## 12.1 开源与许可

| 项目 | 说明 |
|---|---|
| **仓库** | `https://github.com/deepseek-ai/deepseek-harness`（示例地址，以实际为准） |
| **许可协议** | **MIT**（与上游 `deepseek-ai/deepseek-harness` 保持一致，商业友好、允许私有化部署与二次分发） |
| **运行形态** | 完全本地（Local-First）：核心逻辑、数据存储、凭据均在用户本机，不依赖官方云端服务 |
| **费用模型** | **免费**。本工具不收取任何费用，也不代付模型 API 费用 |
| **第三方 API 费用** | 由用户与对应模型厂商（OpenAI / 智谱 / 阿里 / 百度 / 腾讯 等）自行结算，本工具仅作本地调用方 |

## 12.2 功能层级（非收费套餐，仅为自部署开关）

`Free / Pro / Team` 在本项目中**不代表收费套餐**，而是**功能开关的三个层级**，用户可在配置中自由切换：

| 层级 | 定位 | 可用能力（全部免费） |
|---|---|---|
| **Free（个人）** | 单机本地使用 | 全部模型接入、Agent、工具、上下文、流式、基础审批、本地存储 |
| **Pro（进阶）** | 重度个人 / 小团队 | 深度研究、办公连接器、插件市场、云同步（自选后端）、用量仪表盘 |
| **Team（自部署）** | 团队 / 企业内部署 | 第三方登录、**组织与成员管理**、用量按成员配额、**企业 Skill**、**企业专家**、模型配置、**SSO（SAML/OIDC）**、统一模型网关（管理员托管 Key）、**安全审计 & OpenAPI** |

**Team 层级关键能力说明（均为自部署、免费开启）：**

- **企业 Skill（Enterprise Skills）**：管理员可创建、发布和管理**专属于本团队的 Skill 插件**（自动化脚本、内部 API 封装、定制工作流），并一键推送到团队成员客户端。例如：公司内部的代码审查规则、CI/CD 流水线触发、私有数据库查询工具等。团队成员安装后开箱即用，实现**团队能力沉淀与复用**。

- **企业专家（Enterprise Experts）**：管理员可配置**专家 Agent 模板**（如"前端架构师"、"DBA 顾问"、"安全审计员"），预设系统提示词、可用工具集、模型路由策略，供团队成员直接调用。例如：定制的安全审查专家 Agent，绑定内部安全规则库与代码仓库连接器。

- 以上能力均通过**插件系统**（第九章）实现，本质是团队级别的插件分发与 Agent 配置管理，**不涉及任何额外收费**。

- 任一层级均无付费墙，通过配置文件（如 `.env` 中 `DSH_TIER=team`）或环境变量开启对应能力。
- **统一模型网关**（Team）：管理员托管各模型 API Key，按策略路由 + 配额，成员无需自建 Key——此为**便利性能力**，不涉及本工具向成员收费。

## 12.3 用量仪表盘（本地统计，非计费）

```typescript
// 仅作本地用量统计与成本预估，不涉及实际计费/扣费
interface UsageDashboard {
  unit: 'local-stat';   // 本地统计，无积分、无扣费
  track: {
    modelCall:   '按模型统计 Token 消耗（input/output）';
    toolCall:    '工具调用次数';
    agentTask:   'Agent 任务数与子调用明细';
    estimatedCost:'按各厂商公开单价估算的 API 费用（仅供参考）';
  };
  display: { used; history; breakdownByModel; alertThreshold; };
  // 注意：以上仅为可视化统计，不产生任何真实扣款；实际费用由模型厂商按其规则结算
}
```

> 若需**关闭**用量统计，可在设置中将 `telemetry.usage` 设为 `false`。本工具不向任何服务端上报用量数据（除非用户主动启用云同步）。

### 12.3.1 成本估算服务（统一入口）

为避免 `estimatedCost` 在各处"可选/缺失"导致展示不一致，本文档规定：**所有需要展示预估成本的场景（工具调用结果、10.2 审批卡预览、用量仪表盘）都统一通过 `CostEstimationService` 计算**，禁止在调用方各自估算。

```typescript
// 统一成本估算服务：唯一的 estimatedCost 计算入口
class CostEstimationService {
  /**
   * 统一估算接口。返回结构化结果，绝不返回 null/undefined——
   * 无法计算时返回 { kind: 'unknown', display: '费用未知' }，
   * 确保 UI 永远有值可展示（见下方 display 规则）。
   */
  estimate(input: CostEstimateInput): CostEstimateResult {
    const provider = this.registry.get(input.providerId);
    if (!provider) return UNKNOWN;                       // 未注册厂商 → 未知
    const modelInfo = provider.models.get(input.modelId);
    if (!modelInfo) return UNKNOWN;                       // 未知模型 → 未知
    if (!modelInfo.pricePer1MInput && !modelInfo.pricePer1MOutput) return UNKNOWN; // 无单价 → 未知

    // 有单价：按 token / 时长 / 分辨率等维度计算（文本以「每百万 token」为单位）
    const amount = this.calcByDimension(input, modelInfo); // 见下文
    return { kind: 'estimated', amount, currency: 'USD', display: `≈ $${amount.toFixed(4)}` };
  }

  // 多模态按维度计算（图片按张数、视频按时长+分辨率、PPT 按页数+模型 token）
  private calcByDimension(input: CostEstimateInput, info: ModelInfo): number {
    switch (input.kind) {
      case 'text':      return (input.inputTokens / 1_000_000) * info.pricePer1MInput
                           + (input.outputTokens / 1_000_000) * info.pricePer1MOutput;
      case 'image':     return input.count * (info.pricePerImage ?? info.pricePer1MInput);
      case 'video':     return input.durationSec * (info.pricePerSec ?? 0)
                           + this.resolutionFactor(input.resolution) * info.pricePer1MOutput;
      case 'multimodal':return this.calcByDimension({ ...input, kind: 'text' }, info)
                           + (input.pageCount ?? 0) * (info.pricePerPage ?? 0);
      default:          return 0;
    }
  }
}

type CostEstimateInput =
  | { kind: 'text'; providerId: string; modelId: string; inputTokens: number; outputTokens: number }
  | { kind: 'image'; providerId: string; modelId: string; count: number }
  | { kind: 'video'; providerId: string; modelId: string; durationSec: number; resolution?: string }
  | { kind: 'multimodal'; providerId: string; modelId: string; inputTokens: number; outputTokens: number; pageCount?: number };

interface CostEstimateResult {
  kind: 'estimated' | 'unknown';  // 区分"有预估值"与"无法估算"
  amount?: number;                // kind=estimated 时存在
  currency?: 'USD';
  display: string;                // 永远非空：'≈ $0.0320' 或 '费用未知'
}
export const UNKNOWN: CostEstimateResult = { kind: 'unknown', display: '费用未知' };
```

**展示规则（全文档统一）**：所有消费 `estimatedCost` 的 UI / 接口（4.3.2 `VideoGenTool.returns`、10.2 `ApprovalRequest.preview`、12.3 用量仪表盘）**统一按 `result.display` 渲染**：

| `CostEstimateResult.kind` | 展示内容 | 触发场景 |
|---|---|---|
| `estimated` | `≈ $0.0320` | 厂商 + 模型 + 单价均可查 |
| `unknown` | **`费用未知`**（灰字，并提示"该模型未配置单价，可在设置中补充"） | 未注册厂商、未知模型、未填单价（如自建 `openai-compat` 网关） |

- **关键约定**：`display` 字段**永远非空**，因此各场景**无需再判断"字段是否缺失"**——要么显示具体金额，要么显示"费用未知"占位符。这消除了此前"成本字段可选"在工具返回值与审批卡之间可能不一致的问题。
- **单价来源**：`ModelInfo.pricePer1MInput/pricePer1MOutput`（见 2.1，单位为「美元 / 每百万 token」）为本地可编辑的配置，**用户可在「模型 Provider → 添加自定义模型」或用量仪表盘中补充自建网关的单价**；文档内置值仅为示例，以各厂商官方为准。文本类成本统一按 `(输入Tokens / 1_000_000) × 输入单价 + (输出Tokens / 1_000_000) × 输出单价` 估算。
- **非收费声明**：本服务**仅做本地展示用估算**，不扣费、不上报（除非启用云同步），实际费用由用户向模型厂商结算。

> **收敛说明**：4.3.2 `VideoGenTool.returns.estimatedCost` 与 10.2 `ApprovalRequest.preview.estimatedCost` 在类型层面**均统一为 `CostEstimateResult`**（见上），其 `display` 永远有值；不再存在"字段缺失"分支，调用方一律按 `display` 展示即可。

## 12.4 关于与作者联系【新增】

> ⚠️ **【发布前必填】**：本节中所有作者姓名、邮箱、安全联系邮箱、行为准则文件（`CODE_OF_CONDUCT.md`）、许可协议文件（`LICENSE`）均为**占位示例**，请在文档定稿发布前**务必替换为项目维护者的真实信息**。

```typescript
interface AboutInfo {
  project:   'deepseek-harness';
  version:   '由 package.json 自动注入';
  license:   'MIT';   // 与上游 deepseek-ai/deepseek-harness 保持一致
  homepage:  'https://github.com/deepseek-ai/deepseek-harness';
  // ⚠️【发布前必填】以下为占位示例，请替换为真实维护者信息
  authors: [
    { name: '【发布前必填】真实姓名或组织名';     email: '【发布前必填】官方维护邮箱';       role: '核心维护者' },
    { name: '【发布前必填】协作者姓名';           email: '【发布前必填】协作者邮箱';          role: '模型 Provider 模块' }
  ];
}
```

**官方联系与社区渠道：**

| 渠道 | 用途 | 地址 / 方式 |
|---|---|---|
| **GitHub Issues** | Bug 反馈、功能请求 | `https://github.com/deepseek-ai/deepseek-harness/issues` |
| **GitHub Discussions** | 使用讨论、Q&A、想法交流 | `https://github.com/deepseek-ai/deepseek-harness/discussions` |
| **Discord 社区** | 实时交流、答疑 | 邀请链接见仓库 README |
| **邮箱** | ⚠️【发布前必填】安全漏洞私密反馈、商务 / 合作 | `security@【发布前必填】.org`（安全事项请**勿**公开 Issue） |
| **贡献入口** | 参与开发 | 阅读 `CONTRIBUTING.md` 与 `AGENTS.md`；PR 需通过 CI 与签名（DCO） |

**贡献与生态：**
- 插件发现标签：发布插件请添加 `dsh-plugin` 主题标签，便于社区发现。
- 贡献指南：`CONTRIBUTING.md` 说明如何报告 Bug、分支规范、提交代码；`AGENTS.md` 供 AI 协作开发参考。
- 行为准则：⚠️【发布前必填】采用 Contributor Covenant Code of Conduct，请从官方模板（https://www.contributor-covenant.org/）生成真实文件 `CODE_OF_CONDUCT.md` 放入仓库根目录。
- 许可协议：⚠️【发布前必填】以仓库根目录 `LICENSE` 文件为准（MIT 协议文本可从 https://opensource.org/license/mit/ 获取）。

> **说明**：以上标注 `【发布前必填】` 的项目均为占位信息，定稿前请逐项替换。本工具为开源项目，欢迎任何形式的 Issue、PR 与讨论。


# 十三、OpenAPI 与 SDK【新增，全部层级可用；Team 层级含企业增强】

## 13.1 API 网关
- 认证：API Key（Header `Authorization: Bearer dsh_xxx`）+ 可选 OAuth2。
- 限流：按租户/Key 令牌桶，超限返回 `429`。
- 端点：`POST /v1/chat`、`POST /v1/agents/{id}/run`、`GET /v1/conversations`、`POST /v1/tools/invoke`。
- OpenAPI 3.0 Schema 自动生成，可在 `/openapi.json` 下载。

## 13.2 SDK

```python
# Python SDK
from dsh import DSHClient
client = DSHClient(api_key="dsh_xxx")
resp = client.chat.create(model="deepseek:deepseek-chat", messages=[{"role":"user","content":"hi"}])
# 流式
for chunk in client.chat.stream(model="aliyun:qwen-plus", messages=[...]):
    print(chunk.delta, end="")
```

```typescript
// Node.js SDK
import { DSH } from '@deepseek-ai/dsh-sdk';
const dsh = new DSH({ apiKey: process.env.DSH_API_KEY });
const run = await dsh.agents.run('deepresearch', { input: '调研 RAG 框架对比' });
```


# 十四、UI/UX 详细设计（保留 V1）

## 14.1 主界面布局

```typescript
interface MainLayout {
  header:      { height: '48px'; components: { logo; workspaceSelector; agentStatus; notificationCenter; settings; userProfile; }; };
  leftSidebar: { width: '260px'; sections: { fileExplorer; gitPanel; searchPanel; outlinePanel; dependencies; }; };
  editorArea:  { tabs; codeEditor; diffViewer; previewPanel; };
  rightSidebar:{ width: '320px'; sections: { aiChat; agentTasks; toolOutput; contextViewer; modelSelector /* 新增 */; }; };
  bottomPanel: { height: '200px'; sections: { terminal; problems; output; debugConsole; }; };
  statusBar:   { height: '24px'; components: { gitBranch; languageMode; encoding; lineColumn; agentStatus; }; };
}

> **主形态决策（V3.7 原型迭代）**：本客户端的**主形态为「对话居中」**——以 AI 对话为核心工作区（对应 §14.2 `AIChatPanel`，左右侧栏为会话列表 / Agent 任务·工具输出·上下文查看器）。本节 §14.1 的 IDE 三栏布局（`MainLayout`）作为**副形态**提供，适用于需要文件树 / 编辑器 / 终端的重度开发场景，可从顶栏一键切换进入。两者共用同一套会话与 Agent 运行时，互不冲突。

> **视觉风格约定（V3.7 原型迭代）**：采用 **Codex 极简设计风格**，**仅使用黑、白两色（含中性灰度）**，不使用品牌色或语义彩色。主操作色（accent）在浅色主题为近黑 `#0A0A0A`、深色主题为近白 `#F5F5F5`；状态（成功 / 告警 / 危险）仅以文字、描边或灰度深浅区分，不引入红 / 绿 / 黄等彩色。可交互高保真原型见仓库 `prototype/index.html`。
```


## 14.2 AI 对话面板

```typescript
interface AIChatPanel {
  messages: {
    userMessage:      { avatar; bubble; timestamp; actions: { edit; copy; delete; }; };
    assistantMessage: { avatar; content; codeBlocks: { syntaxHighlighting; lineNumbers; copyButton; applyButton; insertButton; runButton; }; toolCalls: { toolName; parameters; result; status; approval? /* 审批卡 */; }; memoryHint?: { icon: '⚡'; text: string; memoryId: string } /* V3.4：基于记忆提示 */; actions: { regenerate; copy; share; addToContext; }; };
    systemMessage:    { type: 'info'|'warning'|'error'|'success'; content; dismissable; };
  };
  inputArea: {
    textarea: { placeholder: '输入消息... (输入 @ 可提及文件/技能/连接器)'; autoResize; maxHeight: '200px'; syntaxDetection; markdownShortcuts: true; };
    toolbar:  { attachFile; insertCode; addContext; selectModel /* 模型切换 */; agentSelector; sendButton; };
    contextBar: { activeFiles; selectedCode; agentContext; clearAll; };
    mention:   { enabled: true; trigger: '@'; /* 见 14.2.1 @提及 */ };
    shortcuts: { send: 'Enter'; newline: 'Cmd+Enter | Ctrl+Enter'; /* 见 14.2.2 快捷键 */ };
  };
  // V3.4：任务批量操作（左侧任务列表）
  taskList: {
    multiSelect: { enabled: true; checkbox: boolean };
    batchActions: { delete: '批量删除'; archive: '批量归档'; export: '批量导出'; share: '批量分享'; };
  };
}
```

### 14.2.1 @提及（Mention）功能【V3.4 新增】

当用户输入 `@` 时，输入框弹出下拉菜单，可快速选择当前项目中的**文件**、已安装的**技能 (Skills)** 或**连接器 (Connectors)**，并自动填入其引用路径或 ID。

```typescript
interface MentionItem {
  type: 'file' | 'skill' | 'connector' | 'memory';
  label: string;          // 显示名，如 "src/auth.ts" / "DeepResearch" / "Jira"
  ref: string;            // 引用标识，如 "@/src/auth.ts" / "@skill:deepresearch" / "@connector:jira:PROJ-123"
  icon?: string;          // 类型图标
  description?: string;   // 补充描述
}
```

**交互流程：**
1. 用户输入 `@` → 弹出分类下拉列表（文件 📄 / 技能 🔧 / 连接器 🔌 / 记忆 🧠）。
2. 继续输入字符进行**模糊搜索过滤**（如 `@auth` → 匹配 `src/auth.ts`、`@skill:auth-helper`）。
3. 选中后自动补全为 `@ref` 格式，**实体高亮显示**（类似 IDE 的 symbol link）。
4. Agent 解析 `@ref` 后自动注入对应上下文（文件内容、技能描述、连接器资源、记忆条目）。

**示例输入：**
```
@src/config.ts 帮我优化这里的超时配置，参考 @skill:best-practices，然后把结果更新到 @connector:jira:PROJ-456
```

### 14.2.2 Markdown 编辑快捷键【V3.4 新增】

| 快捷键 | 功能 |
|---|---|
| `Enter` | 发送消息 |
| `Cmd+Enter` / `Ctrl+Enter` | 换行（不发送） |
| `Shift+Enter` | 换行（不发送） |
| `Cmd+K` / `Ctrl+K` | 聚焦输入框 / 打开命令面板 |
| `@` | 触发 @提及下拉菜单 |
| `Cmd+/` / `Ctrl+/` | 切换 Markdown 预览/编辑模式 |
| `Cmd+Up` / `Ctrl+Up` | 快速切换模型 |
| `Esc` | 取消当前生成 / 关闭下拉菜单 |

> 以上快捷键均可在「设置 → 快捷键」中自定义，并通过云同步保持跨设备一致（见 14.4）。

### 14.2.3 产物分享【V3.4 新增】

每条 Assistant 消息的附件/产物（图片、视频、PPT、Markdown 报告、代码文件等）均提供**分享**按钮：
- **本地链接**：生成 `dsh://share/{taskId}/{artifactId}` 格式的本地深度链接，同一设备内任意窗口可打开预览。
- **云同步链接**（需启用云同步）：生成带短期 Token 的 HTTPS 分享链接，可设置**有效期与访问权限**（仅查看 / 可评论）。
- 分享时**不包含**敏感上下文（API Key、密码等），仅分享产物本身。

```typescript
interface ShareLink {
  artifactId: string;
  url: string;              // 本地 dsh:// 或云端 https://
  expiresAt?: Date;         // 有效期（云端链接）
  permission: 'view' | 'comment' | 'edit';
  createdAt: Date;
}
```

### 14.2.4 任务列表批量管理【V3.4 新增】

左侧任务列表支持**多选模式**（复选框），提供以下批量操作：

| 操作 | 描述 | 交互 |
|---|---|---|
| **批量删除** | 选中多个任务后一键删除 | 选中 → 点击"删除" → 二次确认弹窗 |
| **批量归档** | 将选中的进行中/已完成任务归档 | 选中 → 点击"归档" → 移入归档分区 |
| **批量导出** | 将选中任务（含对话、产物）导出为 JSON / Markdown | 选中 → 点击"导出" → 选择格式 → 下载 |
| **批量分享** | 为选中任务生成分享链接（需云同步） | 选中 → 点击"分享" → 生成链接列表 |


## 14.3 通用设置（General Settings）【V3.4 新增】

设置页新增"**通用 (General)**"标签页，覆盖应用级偏好开关：

```typescript
interface GeneralSettings {
  // 启动行为
  autoLaunch:        boolean;   // 开机时自动启动（注册系统自启动项）
  restoreLastSession: boolean;  // 启动时恢复上次会话
  // 界面与交互
  enableAnimations:  boolean;   // 启用动画效果（消息过渡、流式渲染）
  showDetailedLogs:  boolean;   // 在对话中显示详细操作日志（工具调用参数、模型路由决策等）
  compactMode:       boolean;   // 紧凑模式（减少间距，适合小屏）
  // 语言与区域
  language:          'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR' | 'zh-TW';
  timezone:          string;
  // 记忆管理（关联 5.3）
  memory: {
    autoExtract:     boolean;   // 自动从对话中提取记忆
    showMemoryHint:  boolean;   // 对话中显示 "⚡ 基于记忆" 提示
    forgettingPolicy: ForgettingPolicy;
  };
  // 数据
  telemetry: {
    usage:           boolean;   // 本地用量统计（见 12.3）
    crashReport:     boolean;   // 崩溃报告（仅本地/可选上报）
  };
}
```

**关键设置项说明：**

| 设置 | 默认 | 说明 |
|---|---|---|
| 开机自启动 | `false` | 注册系统自启动项（macOS launchd / Windows 注册表 / Linux systemd user unit） |
| 显示详细操作日志 | `false` | 开启后在对话中展示工具调用的完整参数与模型路由决策过程 |
| 自动提取记忆 | `true` | 关闭后 Agent 不再自动写入长期记忆（已有记忆仍可被检索） |
| 启用动画效果 | `true` | 关闭可提升低配设备流畅度 |

## 14.4 快捷键设置（含云端同步）【V3.4 新增】

快捷键设置页支持**查看/自定义/重置**所有快捷键，并可选**同步到云端**：

```typescript
interface KeymapSettings {
  bindings: Record<string, string>;  // { 'chat.send': 'Enter', 'chat.newline': 'Cmd+Enter', ... }
  syncToCloud: boolean;               // 同步快捷键到云端（依赖云同步功能，见 11.3）
}
```

- **自定义**：点击任意快捷键行，按下新组合键即可覆盖；冲突时提示。
- **重置**：一键恢复默认键位。
- **云端同步**（`syncToCloud = true`）：启用后，快捷键配置随云同步跨设备保持一致（端到端加密传输，见 11.3）。

> 默认键位见 [14.2.2 Markdown 编辑快捷键](#1422-markdown-编辑快捷键v34-新增)。

# 十五、性能指标与优化

```typescript
interface PerformanceMetrics {
  responseTime: { startup: '<3s'; fileOpen: '<100ms'; codeCompletion: '<50ms'; agentResponse: '<1s'; toolExecution: '<500ms'; };
  resourceUsage:{ memory: '<500MB'; cpu: '<30%'; disk: '<1GB'; network: '<10MB/s'; };
  stability:    { uptime: '99.9%'; crashRate: '<0.1%'; errorRate: '<1%'; };
}
```


# 十六、国际化与本地化

```typescript
interface I18nSystem {
  languages: { zhCN: '简体中文'; zhTW: '繁体中文'; enUS: '英语'; jaJP: '日语'; koKR: '韩语'; };
  translationManagement: { translationFiles; fallbackLanguage; dynamicLoading; hotReload; };
  localizedContent: { ui; errors; documentation; tutorials; };
}
```


# 十七、社区与生态建设【新增】
- **GitHub Discussions**：反馈、功能讨论、Q&A。
- **Discord 社区**：实时交流。
- 插件发现标签：发布插件请添加 `dsh-plugin` 主题标签。
- **贡献指南**：阅读 `CONTRIBUTING.md` 与 `AGENTS.md`；Bug 通过 Issue 报告并附复现步骤；PR 需通过 CI 与签名（DCO）。


# 附录 A：模型 Provider 接入速查
| 想接入 | 方式 | 关键点 |
|---|---|---|
| OpenAI 官方 | `openaiProvider` | `OPENAI_API_KEY` |
| 智谱 GLM | `openai-compat` + `open.bigmodel.cn` | Bearer Key |
| 阿里 Qwen | `openai-compat` + DashScope 兼容端点 | `DASHSCOPE_API_KEY` |
| 百度文心 | `baiduProvider` | Key+Secret 换 token |
| 腾讯混元 | `tencentProvider` | TC3 签名 |
| 任意自建 / 网关 | `openai-compat` + 自定义 baseURL | 实现 `/v1/chat/completions` |
| **自定义 API Key** | 任意 Provider，见 2.8 | GUI / `dsh model add` / `.env`；Keychain 加密、多 Key 负载均衡、连通性测试 |
| **长期记忆 (Memory)** | 内置，见 5.3 | 自动提取、手动编辑/删除、语义检索注入、遗忘策略；本地加密存储 |
| **多模态生成（图片/视频/PPT）** | 内置工具，见 4.3 | ImageGen（`generate_image`/`edit_image`）、VideoGen（`generate_video`）、PPTGenerator（`generate_presentation`）；`model` 由 2.4 路由分发，成本由 `CostEstimationService`（12.3.1）统一估算 |
| **成本预估（estimatedCost）** | `CostEstimationService`，见 12.3.1 | 统一入口，返回 `{ kind: 'estimated'\|'unknown', display }`；无法估算时显示"费用未知"占位符，4.3.2 / 10.2 / 12.3 三处统一按 `display` 渲染 |


# 附录 B：目录结构
```
deepseek-harness/
├── packages/
│   ├── kernel/            # Cordis 微内核
│   ├── model-providers/   # deepseek / openai / zhipu / aliyun / baidu / tencent / openai-compat
│   ├── agents/            # codegen / review / debug / test / docs / research
│   ├── tools/             # 文件 / 代码 / 网络 / Git / DB
│   ├── connectors/        # jira / slack / notion / github / gdrive
│   ├── plugins/           # 插件市场
│   └── sdk/               # OpenAPI SDK (Python/Node)
├── apps/web/              # Web UI (dsh web)
├── apps/cli/              # CLI
└── docs/                  # 本文档
```


# 附录 C：版本与变更
- **V3.7（本版）**：原型迭代（产品决策，不改变底层接口）——依据高保真原型 V2 评审落地三项决策：① **主形态 = 对话居中**：默认进入「AI 对话（主形态）」，§14.1 IDE 三栏布局降为「主工作区 · IDE（副形态）」，顶栏可切换，共用会话与 Agent 运行时；② **Codex 极简黑白配色**：设计令牌改为纯黑白灰单色体系，移除品牌蓝与全部语义彩色，状态仅以文字 / 描边 / 灰度区分；③ **成本按每百万 token 单价估算**：「添加自定义模型」新增「输入 $/1M · 输出 $/1M」单价字段，用量仪表盘与审批卡按配置单价实时计算 `≈ $金额`，未配置单价显示「费用未知」（沿用 12.3.1 `CostEstimationService`）。原型 V2（`prototype/index.html`）为权威 UI 参考实现。
- **V3.6（本版）**：接口完备性与展示一致性修复（不改变外部功能）——① **修复长期记忆 UI 数据来源缺失**：5.3.4 `MemoryRetriever.buildMemoryContext()` 由仅返回 `string` 改为返回 `{ systemPrompt, references: MemoryReference[] }`，`MemoryReference` 含 `memoryId` + 摘要，作为 14.2 `assistantMessage.memoryHint` 的**唯一数据源**，消除 UI 字段"无源之水"问题；5.3.2「对话中引用记忆」行同步补充该数据流向说明；② **统一 `estimatedCost` 计算入口（优化建议采纳）**：新增 12.3.1 `CostEstimationService`，作为工具调用、审批卡、用量仪表盘三处成本展示的统一计算源，返回 `CostEstimateResult { kind: 'estimated'|'unknown', display }`，无法估算（未注册厂商 / 未知模型 / 无单价）时显示"**费用未知**"占位符而非缺失字段，UI 无需再判空；4.3.2、4.3.5、10.2 的相关字段描述同步指向该服务；③ **版本号**：标题与页眉统一为 V3.6。
- **V3.5**：内部一致性自审与修复（不改变外部功能）——① **恢复「4.3 多模态内容生成工具集」**：此前版本（V3.4）正文遗漏了 V3.3 已声明的 4.3 章节，本次补回 ImageGen / VideoGen / PPTGenerator、4.3.4 多模态 Provider 适配矩阵、4.3.5 产物管理，与 V3.3 变更记录、附录 A/B 对齐；② **消除"计费"表述冲突**：将 10.2 `estimatedCost`、4.3 中的"本地计费"统一为"**本地成本预估，非本工具收费**"，与"无积分/无计费"定位一致；③ **修正交叉引用**：2.1 `pricePer1kInput/Output` 明确指向 12.3 `UsageDashboard.estimatedCost`；④ **第十三章标题**：由"Team 及以上"改为"全部层级可用；Team 层级含企业增强"，与 12.2"所有层级无付费门槛"一致；⑤ **版本号同步**：标题与页眉版本号统一为 V3.5。
- **V3.4（本版）**：功能完备性补充——① **新增「5.3 长期记忆管理与编辑」**：定义 `LongTermMemory` 数据模型（fact/preference/habit/conclusion/summary 五类）、自动提取、手动编辑/删除/新增、语义检索注入、遗忘/归档策略、隐私安全（本地加密），UI 入口与交互设计；② **连接器完善**：为 Google Drive、Office 365 补充典型工具示例（Docs/Sheets/Slides/Outlook/Word/Excel 等），新增**腾讯文档**本土化示例；③ **Team 层级深化**：补充「企业 Skill」与「企业专家」的设计解释；④ **UX 效率工具**：任务列表批量管理（多选/批量删除/归档/导出/分享）、产物一键分享链接、输入框 `@mention`（文件/技能/连接器/记忆）、Markdown 快捷键（Enter 发送 / Cmd+Enter 换行）、通用设置页（开机自启/动画/详细日志）、快捷键云端同步。
- **V3.3**：新增「4.3 多模态内容生成工具集」（ImageGen / VideoGen / PPTGenerator + 多模态 Provider 适配矩阵），接入 2.4 模型路由、10.2 手动审批（estimatedCost，本地成本预估）、产物管理（见 4.3.5）与深度研究 → PPT 快捷生成。
- **V3.2**：项目名称按场景统一（正文/命令/附录 C 收敛为小写 `deepseek-harness`，仅保留首词与类名大写）；「关于与作者联系」占位项全部加 `【发布前必填】` 警示框。
- **V3.1**：在 V3.0 基础上做精确性与可落地性细节优化——① 许可协议由"Apache 2.0 或 MIT"**收敛为 MIT**，与上游 `deepseek-ai/deepseek-harness` 保持一致；② **全文档仓库路径统一为小写** `deepseek-ai/deepseek-harness`（克隆、homepage、Issues、Discussions、目录结构）；③ 在「十二、开源发布、功能层级与关于」开头**明确强化开源/免费属性声明**（自由使用、修改、分发，无需付费）；④ **新增「2.8 自定义模型与自定义 API Key 管理」**（GUI/CLI/配置文件三种添加、多 Key 负载均衡、Keychain 加密与安全导入导出、连通性测试、运行时切换），补齐用户自备 Key 的完整闭环。
- **V3.0**：**定位调整为开源本地运行工具**——移除积分（Credit）与付费计费系统，订阅层级改为自部署功能开关；新增「关于与作者联系」章节；模型调用费用改为用户自行承担，用量仪表盘仅作本地统计与成本预估；保留万物皆插件 + Cordis 架构、模型 Provider 体系（OpenAI/智谱/阿里/百度/腾讯等）、深度研究、连接器、OpenAPI、安全合规、云同步、社区。
- **V2.0**：引入万物皆插件 + Cordis；新增模型 Provider 体系、深度研究、连接器、OpenAPI、订阅积分、安全合规、云同步、社区。
- **V1.0**：WorkBuddy 功能复刻（UI、Agent、工具、上下文、流式、插件雏形、权限、持久化、性能、i18n）。

---
*本文档基于公开信息与《修改意见汇总》整理。本项目为开源本地运行工具，不涉及付费计费；涉及第三方模型的具体端点、定价请以各厂商官方文档为准，本文档中的价格/用量仅为本地成本预估示例。*
