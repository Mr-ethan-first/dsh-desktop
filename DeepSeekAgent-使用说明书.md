# DeepSeekAgent 使用说明书

| 版本 | 日期 | 适用产物 |
|---|---|---|
| 1.0 | 2026-09-04 | `DeepSeekAgent-Setup-0.1.0.exe`（165MB，NSIS 安装包） |

DeepSeekAgent 是基于 deepseek-harness 的 Windows 桌面 AI 编程助手：内置**原生 DeepSeek 模型**（官方 `api.deepseek.com`），**不预置任何 API Key**——首次使用前请准备好你自己的 [DeepSeek 开放平台 API Key](https://platform.deepseek.com)。

---

## 1. 安装

1. 双击 `DeepSeekAgent-Setup-0.1.0.exe`；
2. 安装向导中可选择安装目录，默认 `%LOCALAPPDATA%\Programs\DeepSeekAgent`；
3. 安装完成后桌面和开始菜单会出现 **DeepSeekAgent** 快捷方式。

> 静默安装（可选，供运维脚本使用）：
> `DeepSeekAgent-Setup-0.1.0.exe /S /D=D:\你的目录`
>
> 说明：安装包未做代码签名，部分浏览器/系统首次下载或运行时可能提示"未知发布者"，选择"仍要运行"即可；本安装包已通过完整安全审计（包内无任何预置凭证，默认模型仅 DeepSeek 原生）。

## 2. 首次启动与配置 API Key（必做）

1. 双击 **DeepSeekAgent**（或桌面快捷方式）。主窗口会先短暂显示"正在启动本地工作台"，随后自动进入 **DSH 对话工作台**（全程只在客户端窗口内展示，不会自动打开浏览器）；
2. 进入工作台的 **设置 → 模型/凭据** 页面，填入你的 **DeepSeek API Key**（`sk-` 开头）并保存；
3. 回到对话页，默认模型即为原生 **deepseek-v4-flash**（可在模型列表切换 deepseek-v4-pro / deepseek-v4-flash-vision-exp）；
4. 发送一条消息测试。若未配置 Key，消息会返回 401 提示，按提示回设置页填写即可——**填完立即生效，无需重启**。

### 备选方式：.env 文件

不便使用界面配置时，可在 **exe 安装目录旁**（或 `%APPDATA%\@deepseek-ai\dsh-agent-client\`）创建 `.env` 文件：

```ini
DEEPSEEK_API_KEY=sk-你的key
# 可选：
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DEEPSEEK_MODEL=deepseek-v4-flash
```

保存后重启应用生效。**注意：`.env` 内含明文 Key，请勿提交到代码仓库或随文件分享。**

## 3. 日常使用

### 3.1 对话与工作区

- 在对话页直接与智能体对话；涉及文件操作的任务请先在右侧面板**选择工作目录**（使用系统原生文件夹选择器），并设置权限等级（读取 / 写入 / 执行，默认执行）；
- 工作目录与权限会自动记忆，下次启动自动恢复；
- 会话自动持久化（本地 SQLite），重启后可继续历史会话。

### 3.2 工作模式

对话支持 **Ask / Plan / Craft** 三种模式（界面顶部切换）：

| 模式 | 行为 |
|---|---|
| Ask | 只读问答，不改文件 |
| Plan | 先产出计划，确认后再执行 |
| Craft | 完整自主执行（工具调用 + 文件修改） |

### 3.3 MCP 工具

设置中可添加 MCP 服务器（HTTP/SSE 传输），配置可放在安装目录旁的 `mcp-servers.json`：

```json
[ { "id": "excel", "name": "Excel MCP", "url": "http://127.0.0.1:8000/mcp", "enabled": true } ]
```

### 3.4 插件

「插件」页可浏览本机插件与**社区市场**（离线策展目录，2452 项，点击链接在系统浏览器打开详情）。启用插件后重启客户端生效。

## 4. 卸载

- 开始菜单 / 系统设置 →「应用」→ DeepSeekAgent → 卸载；
- 卸载过程**无任何黑色命令行窗口**，静默完成，安装目录将被彻底清空；
- 你的 API Key、会话记录等用户数据保存在 `%APPDATA%\@deepseek-ai\dsh-agent-client\`，卸载不会删除；如需彻底清除，请手动删除该目录（内含你的 Key，注意保密）。

## 5. 常见问题（FAQ）

**Q1：发消息没有反应 / 提示 401？**
未配置或 Key 无效。到设置页确认 Key 已保存（DeepSeek 官方 Key，`sk-` 开头）。配置后立即生效。

**Q2：启动后一直停在"正在启动本地工作台"？**
正常 10–40 秒内进入工作台。超过 1 分钟会自动回退到内置界面（功能完整，可正常对话）。若频繁如此，检查是否杀软拦截了安装目录下的 `resources\dsh-runtime`，将其加入白名单。

**Q3：会不会自动打开浏览器？**
不会。所有界面都在客户端窗口内展示；dsh 工作台后端仅监听本机 127.0.0.1，且带一次性令牌鉴权。

**Q4：关闭程序后端口还被占用吗？**
不会。退出时会精确终止本程序启动的全部子进程并释放端口（仅针对自身启动的进程，不影响其他软件）。

**Q5：模型列表里还有智谱/通义千问吗？**
没有。默认仅 DeepSeek 原生三模型。如需其他 OpenAI 兼容服务商，可在设置中自定义端点与模型（端点需你自己提供 Key）。

**Q6：升级安装需要注意什么？**
直接运行新安装包覆盖即可。用户数据（Key、会话）不受影响。若从 2026-09-04 之前的旧版本升级，建议先卸载旧版再安装（旧版可能残留过期的本地模型配置，如遇模型列表异常，删除 `%APPDATA%\@deepseek-ai\dsh-agent-client\dsh-home\settings.yaml` 后重启即可恢复默认）。

**Q7：杀毒软件报未知发布者/拦截？**
安装包未签名。将安装目录加入杀软白名单可避免实时扫描导致的启动/卸载缓慢。

## 6. 日志与排障

| 日志 | 位置 | 用途 |
|---|---|---|
| 启动/崩溃/内存 | `%TEMP%\dsh-agent-logs\`（`startup-*` / `crash-*` / `oom-snapshot-*` / `electron-*`） | 反馈问题时请附带当日文件 |
| 渲染层日志 | 同目录 `agent-<date>.log` | 前端异常 |
| 启动器日志 | 安装目录 `logs\agent-<时间戳>.log`（经 DeepSeekAgent.cmd 启动时） | 启动链路 |

提交问题反馈时请附带：上述当日日志 + 复现步骤 + 大致时间点。

## 7. 高级配置（可选）

| 环境变量 | 作用 |
|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | Key 与端点/模型覆盖（建议用 .env 或界面配置） |
| `DSH_HOME` | 会话/技能主目录（默认 `~/.deepseek-harness`） |
| `DSH_RATE_LIMIT_MS` | LLM 请求最小间隔毫秒（默认 60000，0 为不限） |
| `DSH_MAX_PARALLEL_TOOL_CALLS` | 工具最大并行数（默认 4） |
| `DSH_PERSISTENCE` / `DSH_SQLITE_PATH` | 持久化方式与数据库路径 |
| `DSH_MCP_SERVERS` | MCP 服务器 JSON 数组 |

> 安全说明：应用启动时会**主动忽略**来自系统环境变量的服务商 Key/端点继承（防止机器上残留的旧变量被静默采用），仅认 `.env` 显式配置与应用内设置。排障时如需恢复旧行为，设 `DSH_TRUST_LAUNCH_ENV=1`。

## 8. 安全与隐私要点

- API Key 仅保存在本机（应用设置存储 / `.env`），请求直达 `api.deepseek.com`，不经过任何第三方中转；
- 工作台服务只绑定 `127.0.0.1`，局域网不可访问，并使用一次性令牌鉴权；
- 包体内不含任何预置凭证（交付时经自动化扫描验证）；
- 工具对文件系统的操作受工作目录与权限等级约束。

---

*技术细节见《DeepSeekAgent-架构设计说明书.md》与《DeepSeekAgent-详细设计说明书.md》。*
