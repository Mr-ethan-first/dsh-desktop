# 办公自动化 MCP 集成指南（DeepSeek 智能体客户端 · exe）

本客户端仅支持 **HTTP（JSON-RPC）形态**的 MCP（`electron/harness/mcp.ts` 的 `McpServerConfig` 只有 `url`，不支持 stdio）。本文说明如何把成熟的办公自动化 MCP 服务接入本 exe，实现 Excel / Word / PowerPoint 自动化。

> 形态说明：本软件交付物是 Windows 可执行文件（`DeepSeek 智能体客户端.exe`），由 Electron 打包。办公 MCP 服务**由你本地先启动**，exe 通过 HTTP 连接（即"连接已启动的服务"模式），不在 exe 内嵌拉起。

## 选型（不重复造轮子）

| 能力 | 项目 | 形态 | 接入方式 |
|---|---|---|---|
| Excel | [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server)（~3.8k★, MIT） | 原生支持 `streamable-http` | `uvx excel-mcp-server streamable-http` |
| Word | [dosev-ai/mcp-office](https://github.com/dosev-ai/mcp-office)（本地优先） | 仅 stdio | 用 supergateway 桥接为 streamable-http |
| PowerPoint | 同上 mcp-office | 仅 stdio | 用 supergateway 桥接为 streamable-http |

Word/PPT 的 mcp-office 服务器只讲 stdio，因此用成熟的 [supergateway](https://github.com/supercorp-ai/supergateway) 把它桥接为 streamable-http，无需自研任何代理代码。

## 一、前置依赖

1. **uv / uvx**：https://github.com/astral-sh/uv （用于拉起 excel-mcp-server）
2. **Python 3.11+** 与 **pip install mcp-office**（Word/PPT；纯文件读写无需装 Office，COM 高级特性才需要）
3. **npx**（随 Node 提供）：supergateway 经 `npx -y` 自动拉取

## 二、启动办公 MCP 服务

一条命令启动全部三个服务：

```bash
# 在 apps/agent-client 目录下
OFFICE_ROOT=D:/你的办公文件目录 node scripts/start-office-mcp.mjs
```

也可用 npm script：

```bash
pnpm office:mcp:start        # 等价于上面的 node 脚本
pnpm office:mcp:excel        # 仅启动 Excel
```

启动后监听：

| 服务 | 端点 |
|---|---|
| Excel | `http://127.0.0.1:8017/mcp` |
| Word | `http://127.0.0.1:8020/mcp` |
| PowerPoint | `http://127.0.0.1:8021/mcp` |

`Ctrl+C` 停止全部。Word/PPT 的 `WORD_ALLOWLIST_ROOTS` / `PPT_ALLOWLIST_ROOTS` 默认取 `OFFICE_ROOT`，请把它指向你信任的文件目录。

## 三、让 exe 连接这些服务

客户端在 `loadHarnessConfig` 时按以下优先级读取 MCP 服务器列表（见 `electron/harness/config.ts`）：

1. **环境变量 `DSH_MCP_SERVERS`**（JSON 数组字符串，最稳妥）
2. 文件 `mcp-servers.json`，依次查找：
   - `<cwd>/config/mcp-servers.json`
   - `<cwd>/mcp-servers.json`
   - `<exe 同级>/mcp-servers.json`（分发 exe 时放在 exe 旁边）

示例配置（`config/mcp-servers.json.example` 可复制改名）：

```json
[
  { "id": "office-excel", "name": "Excel（办公自动化）", "url": "http://127.0.0.1:8017/mcp", "enabled": true },
  { "id": "office-word",  "name": "Word（办公自动化）",  "url": "http://127.0.0.1:8020/mcp", "enabled": true },
  { "id": "office-ppt",   "name": "PowerPoint（办公自动化）", "url": "http://127.0.0.1:8021/mcp", "enabled": true }
]
```

运行 exe 前设置（二选一）：

```bash
# 方式 A：环境变量
set DSH_MCP_SERVERS=[{"id":"office-excel","name":"Excel","url":"http://127.0.0.1:8017/mcp","enabled":true},{"id":"office-word","name":"Word","url":"http://127.0.0.1:8020/mcp","enabled":true},{"id":"office-ppt","name":"PowerPoint","url":"http://127.0.0.1:8021/mcp","enabled":true}]

# 方式 B：把 mcp-servers.json 放到 exe 同级目录
```

启动 exe 后，主进程 `McpRuntime` 会自动 `initialize` 各服务、拉取工具并以 `mcp__<serverId>__<tool>` 命名空间注册，Agent 即可在对话中调用这些办公工具。

## 四、客户端兼容性要点（已实现）

为了让 exe 真正连上 streamable-http 服务，`electron/harness/mcp.ts` 已增强：

- `initialize` 后捕获响应头 `Mcp-Session-Id` 并在后续 `tools/list` / `tools/call` 中回传（FastMCP 等要求）。
- 兼容 `application/json` 与 `text/event-stream`（SSE）两种响应体。
- 按服务器缓存 `McpJsonRpcClient` 实例，确保会话标识在多次请求间复用（否则真实服务会拒绝调用）。

## 五、本地打包 exe

```bash
cd apps/agent-client
pnpm install
pnpm dist:electron      # tsc --noEmit + build:harness + vite build + electron-builder --win portable
```

产物在 `apps/agent-client/release/DeepSeek 智能体客户端-<version>.exe`（便携版，无需安装）。

## 六、自动化测试

```bash
cd apps/agent-client

# 1) 单元/集成（离线、无需 Office/网络）：覆盖 MCP 客户端、配置解析、streamable-http 端到端
npx vitest run electron/harness

# 2) 真实办公服务集成（默认跳过；先按第二节启动服务后开启）
DSH_TEST_OFFICE=1 npx vitest run electron/harness/mcp-office.integration.test.ts
# 或：pnpm test:office（同样需先设置 DSH_TEST_OFFICE=1）
```

测试覆盖：

- `config.test.ts`：`resolveMcpServers` 的 env / 文件解析与容错。
- `mcp.test.ts`：McpRuntime 服务器管理、Schema 转换、工具注册、多服务器容错（既有）。
- `mcp-streamable-http.test.ts`：进程内真实 streamable-http 服务器，验证会话标识复用与工具发现/调用路由。
- `mcp-office.integration.test.ts`：门控测试，连接真实 Excel/Word/PPT 服务并断言工具可发现（未启动则跳过）。

## 七、常见问题

- **工具列表为空 / 连接失败**：确认对应端口服务已启动；检查 `WORD_ALLOWLIST_ROOTS` 等根目录配置；查看 exe 日志（`logs/`）中 `[mcp]` 报错。
- **Word/PPT 无工具**：确认 `pip install mcp-office` 且 `python -m wordmcp.server` 可用（可在终端单独试跑）。
- **session 相关 4xx**：已通过客户端会话标识复用修复；若仍报错，确认 supergateway 以 `--stateful` 启动（本脚本已默认加）。

## 八、exe 无头自动化冒烟测试（推荐日常用）

手动打开 exe 点击验证效率极低。主进程已内置 **`/healthz` 无头健康检查端点**（端口 `5183`，见 `electron/main.cjs`），暴露 harness 就绪状态与每个 MCP 服务器的连接诊断。配合 `scripts/automated-test-exe.mjs` 可一键完成「构建 → 打包 → 启动 exe → 探测 → 断言 → 关闭」全流程，**无需人工点击**。

### 8.1 端点返回结构

```jsonc
GET http://127.0.0.1:5183/healthz
{
  "ok": true,
  "uptimeMs": 1234,
  "harness": { "ready": true, "error": null },
  "mcpServers": [
    { "id": "office-excel", "name": "Excel（办公自动化）", "url": "http://127.0.0.1:8017/mcp",
      "connected": true, "error": null, "toolCount": 22 }
  ],
  "version": "0.1.0",
  "electron": "30.5.1"
}
```

`harness.ready` 为 `true` 即表示主进程已成功加载；`mcpServers[].connected` 表示对应办公服务是否真正连上。

### 8.2 一键脚本

```bash
cd apps/agent-client

# 全量：构建 harness + 前端 + 打包 exe + 启动 exe + 无头探测断言
node scripts/automated-test-exe.mjs

# 仅测已打包好的 exe（跳过构建/打包，迭代更快）
node scripts/automated-test-exe.mjs --no-pack

# 连真实办公服务，额外验证至少有一个 MCP 已 connected
DSH_TEST_OFFICE=1 node scripts/automated-test-exe.mjs

# 显式指定期望注入的 MCP 服务器数量
DSH_EXPECT_MCP=3 node scripts/automated-test-exe.mjs
```

脚本行为：

1. 默认 **无头启动 exe**（`DSH_HEADLESS=1`，不弹窗口）；设 `DSH_SHOW_WINDOW=1` 可显示窗口调试。
2. 轮询 `/healthz` 至多 90s，直到 `harness.ready` 且 `harness.error` 为空。
3. 断言注入的 MCP 服务器数量 ≥ 期望值（默认按 `config/mcp-servers.json` 推断；没有则 0）。
4. 若 `DSH_TEST_OFFICE=1`，额外要求至少一个 MCP `connected=true`（需先按第二节启动办公服务）。
5. 自动 `taskkill` 关闭 exe，输出 `RESULT: PASS / FAIL` 与退出码。

> 仅验证 exe 启动与配置注入时**不依赖**办公服务是否在线（`connected` 可为 false）；只有开启 `DSH_TEST_OFFICE=1` 才要求连通。

