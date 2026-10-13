# DSH Agent Client

基于 **deepseek-harness** 二次开发的智能体客户端（可运行纵向切片）。

- **设计来源**：`../DeepSeek-harness智能体客户端.md`（V3.7）+ `../prototype/index.html`（V2 原型）
- **主形态**：对话居中（Codex 极简黑白风格，§14.2）
- **集成方式**：**外层独立适配层** `src/adapter`，直连智谱 OpenAI 兼容接口；**不修改 harness 任何代码**，harness 可独立升级。

## 技术栈（沿用仓库选型）

- React 18 + Vite 6 + TypeScript（与 `apps/web` 一致）
- 无新增框架 / 构建工具；仅 react/react-dom + vite/vitest 等已存在于工作区的依赖
- 适配层为纯 TS 模块，**零 harness 依赖**

## 目录

```
apps/agent-client/
├─ src/
│  ├─ adapter/            # 外层适配层（harness 之外）
│  │  ├─ types.ts         # 类型定义
│  │  ├─ provider-config.ts  # 仅从环境变量/配置文件读取，绝不硬编码密钥
│  │  ├─ cost.ts          # 每百万 token 单价成本估算
│  │  ├─ zhipu.ts        # 智谱 OpenAI 兼容客户端（流式/降级/多Key池/额度）
│  │  └─ zhipu.test.ts   # 离线测试（mock fetch，无需真实密钥）
│  ├─ state.tsx          # 全局状态（屏幕/主题/设置/用量/通知）
│  ├─ App.tsx            # 外壳（导航轨 + 顶栏 + 主题/额度/通知）
│  ├─ screens/           # chat / providers / settings / placeholder
│  └─ styles.css         # Codex 黑白极简
├─ vite.config.ts        # 含智谱代理插件（密钥仅服务端注入）
├─ .env.example          # 环境变量模板（密钥禁止硬编码）
└─ package.json
```

## 运行

```bash
# 1) 安装（workspace 已纳入 apps/*，根目录执行即可；仅链接已缓存依赖）
pnpm install

# 2) 配置密钥（复制模板，填入你的智谱 API Key）
cp .env.example .env
#   编辑 .env：保留 ZHIPU_PROXY=/zhipu，填入 ZHIPU_API_KEY=...

# 3) 开发态启动（Vite 代理在 /zhipu 注入密钥，密钥不进浏览器）
pnpm --filter @deepseek-ai/dsh-agent-client dev
#   打开 http://localhost:5173
```

## 模型接入与降级（需求 #3）

- **接口**：OpenAI 兼容 `POST {apiBase}/chat/completions`（默认智谱 `https://open.bigmodel.cn/api/paas/v4`）
- **主模型**：`glm-5.1`；**兜底模型**：`glm-4.7-flash`
- **额度**：`ZHIPU_TOKEN_BUDGET=20000000`（约 2000 万 token）。会话累计达上限 → 自动切换兜底并提示
- **失败降级**：主模型返回 500 / 网络错误 → 自动降级兜底并提示
- **多 Key 池**：`ZHIPU_API_KEYS=key1,key2`，遇到 429 自动剔除该 Key 并冷却，轮换下一个
- **密钥安全**：开发态经 Vite 代理（`.env` 经 `loadEnv` 读取，仅服务端持有）；直连模式由客户端携带，但**密钥仍只来自环境变量/配置，不硬编码**

## 成本估算（需求 #3 / 文档 §12.3.1）

- 单价来自 `ModelInfo.price`（每百万 token 输入/输出），**可配置**
- 未配置单价的模型显示「费用未知」；配置后在「设置中心 → 用量仪表盘」按
  `≈ $(输入/1e6×输入单价 + 输出/1e6×输出单价)` 实时估算并汇总

## 测试

```bash
pnpm --filter @deepseek-ai/dsh-agent-client test
```

`zhipu.test.ts` 用 mock `fetch` 模拟智谱 SSE 与 429，验证：流式解析、额度耗尽降级、
调用失败降级、多 Key 池 429 剔除、成本估算。**无需真实 API Key**。

> 真实接口 e2e 需要你在 `.env` 中填入有效 `ZHIPU_API_KEY` 后，于「模型 Provider」屏点「连通性测试」。

## 与 harness 的关系

- 本应用**不 import、不修改 `packages/` 下任何 harness 代码**，也不改动仓库根配置。
- 新应用通过 `apps/*` 工作区 glob 自动纳入，对 harness 为纯增量。
- 后续可将对话流量从「直连智谱」平滑切到 harness 的 Typert RPC 网关（`packages/api`），
  只需在 `provider-config.ts` 中改 `apiBase`，适配层接口保持不变。
