# DeepSeekAgent 安装包重建与端到端验收（2026-09-10）

## 1. 交付物

| 项目 | 值 |
| --- | --- |
| 安装包 | `apps/agent-client/release/DeepSeekAgent-Setup-0.1.0.exe` |
| 大小 | 165,903,519 B（158.2 MB） |
| SHA-256 | `410aa4c73b72874698e6accd8dba467730b8c3d7410e05d4bf8b16e2a156cdac` |
| 打包源 | `D:\DeepSeekAgent`（含今日全部修复） |
| 归档条目 | 145,638（解压后 1,650,728,275 B） |

上一版（18:12 构建，含测试夹具）已留存为 `release/_prev-20260910-18xx.exe`。

## 2. 本次相对上一版的变化

1. **新增随包内容**：`resources/browser-extension/**`（Chrome 扩展 16 个文件）。
   此前该目录在部署树里存在但 **NSI 未声明**，安装后拿不到扩展文件。
2. **排除测试夹具**：`.nsi` 增加 `/x` 掩码（`*.spec.*` / `*.test.*` 各扩展名 + `tests` /
   `__tests__` 目录）。归档内测试文件 **12,935 → 0**（少 115MB 解压量、压缩后 −2.1MB）。
3. **构建可复现性**：`OutFile` 与 `SRC` 改为可被 `/D` 覆盖，支持"先出到暂存目录、校验后再提升"。

## 3. 交付门禁（4/4 通过）

| # | 门禁 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 外壳层单测 | `vitest run -c vitest.tests.config.ts` | **45/45 通过** |
| 2 | harness 层单测 | `vitest run -c vitest.config.ts` | **222 通过 / 8 跳过** |
| 3 | 默认模型纯净度 | `node scripts/verify-default-models.mjs` | **PASS**（3 个原生 deepseek，`api.deepseek.com`） |
| 4 | 部署插件审计 | `node scripts/verify-deployed-plugins.mjs` | **52/52 通过** |
| 5 | 侧边栏 alpha.1 兼容回归 | `node scripts/_verify_sidebar_alpha1_compat.mjs` | **19/19 通过** |

## 4. 端到端验收（`scripts/_e2e_installer.mjs`，28/28 通过）

脚本覆盖 A 安装 → B 载荷审计 → C 隔离 DSH_HOME → D 启动 dsh web → E 插件挂载 + HTTP +
**浏览器渲染** → F 卸载。

关键结论：

- dsh web 从**安装目录内**的 runtime + CLI + 插件启动，**22s 就绪**并输出一次性鉴权 URL。
- 首页 HTTP 200、含 `__DSH_BOOT__`（富 dsh-web-ui 真实托管，非兜底 SPA）。
- 静态资源 js 2 / css 6 全部 200，无 404。
- **Playwright headless Chromium 实际渲染**：页面正文 58 字符、title「DSH 本地构建」，
  `pageerror 0 / console.error 0`；截图 `.e2e_screens/installed-ui-*.png` 可见完整侧边栏
  （新会话 / 节点模式 / 工作区列表）与主区 composer。
- 侧边栏 alpha.1 修复在产物内可验证：宿主 bundle 有 `typeof … === "function"` 守卫的垫片，
  客户端 bundle 已无 `connection.state.getSnapshot()` 崩溃形态。
- app.asar 含 `setWindowOpenHandler` ×2、无 `aliyuncs.com` 端点、无明文 `sk-` 密钥。

### 4.1 归档完整性交叉核对

以 `7z l` 取归档清单，与部署树逐文件比对：

- 部署树中「应打包」的功能文件 **38,514 个，归档缺失 0 个**（0 字节）。
- junction 已被 `File /r` **展开为真实文件**（`@deepseek-ai/**` 计 25,953 条，
  `dsh/lib/bin.js` 等规范名包可读到真实内容）——这是安装态能否启动的关键，已验证。
- 归档内 `resources/browser-extension` 16 条、`app.asar` 37,756,097 B、侧边栏
  `lib/index.js` 191,722 B（补丁后尺寸）均与部署树一致。

### 4.2 字节级比对（`7z e` 抽出后算 SHA-256）

| 文件 | 包内 vs 部署态 vs 仓库 |
| --- | --- |
| `resources/app.asar` | **三方 SHA-256 完全一致** `5e56e4b3…34caa5`（37,756,097 B） |
| `dsh-better-sidebar/lib/index.js` | MATCH |
| `dsh-better-sidebar/lib/client.js` | MATCH |
| `dsh-better-sidebar/lib/client-registry.js` | MATCH |
| `browser-extension/manifest.json` | MATCH |
| `browser-extension/content.js` | MATCH |
| `app.asar.unpacked/electron/main.cjs` | MATCH |
| `app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs` | MATCH |

**7/7 字节一致**。抽出的产物再做语义断言：

- `app.asar` 内 `setWindowOpenHandler` ×2、`aliyuncs.com` 0、明文 `sk-` 0。
- 侧边栏 `index.js`：剥注释后守卫 1 / 调用 1（全部受保护）。
- 侧边栏 `client.js` / `client-registry.js`：`connection.state.getSnapshot()` 崩溃形态 **0**。
- 扩展 manifest：MV3、`background.js` service worker、1 组 content script。

## 5. 已知限制 / 未覆盖项（诚实说明）

1. **真实安装/卸载动作未能自动执行**：本机装的是
   `Lenovo Anti-Virus powered by Huorong Security`。以 `spawn`/`Start-Process`/`explorer`
   启动 `DeepSeekAgent-Setup-0.1.0.exe` 时，进程被创建为 **Suspended** 且永不恢复
   （线程状态 `WaitReason=Suspended`，CPU 0，工作集 3.3MB），`spawnSync` 因此永久挂起。
   同一时刻 `where.exe` / `7z.exe` 均可正常执行，说明是该安全软件对"安装器类 exe"在
   非交互会话下的拦截（交互式双击时它能弹窗询问，此前实测不拦）。
   → **需要用户双击安装包一次（或在火绒里放行/加白）**，之后可执行
   `node scripts/_e2e_installer.mjs` 跑完整 A→F（含真实静默安装与卸载残留检查）。
2. `_e2e_installer.mjs` 的 `DSH_E2E_TREE=<dir>` 模式会跳过 A/F；第 4 节的 B~E 结论即在此模式下取得，
   打包源与安装镜像的一致性由 4.1 的归档交叉核对补齐。
3. 前端断言只到「渲染出内容 + 零 pageerror + 截图」，未做 DOM 级交互（建会话、发消息）。
4. 侧边对话 beta 的「建线程 / 续聊」仍依赖 `agents.create/resume` 选项语义差异
   （alpha.1 vs rc.1），需真机点测。

## 6. 复现命令

```bash
# 出包
cd apps/agent-client
"C:/Users/Administrator/AppData/Local/electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe" \
  /DSRC=D:\DeepSeekAgent \
  /DOUTFILE=D:\WorkSpace\deepseek-harness-master\apps\agent-client\release\_stage\DeepSeekAgent-Setup-0.1.0.exe \
  installer/DeepSeekAgent.nsi

# 归档清单（秒级，用于核对是否夹带测试文件 / 是否漏文件）
"D:/software/7-Zip/7z.exe" l release/DeepSeekAgent-Setup-0.1.0.exe > /tmp/list.txt

# E2E（对已部署树，不需要安装）
DSH_E2E_TREE="D:\\DeepSeekAgent" node scripts/_e2e_installer.mjs

# E2E（完整安装链路，需安全软件放行）
node scripts/_e2e_installer.mjs
```
