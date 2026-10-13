# DeepSeekAgent 启动故障修复 + 打包管线加固（2026-09-18）

## 1. 交付物

| 项目 | 值 |
| --- | --- |
| 安装包 | `apps/agent-client/release/DeepSeekAgent-Setup-0.1.0.exe` |
| 大小 | 166,725,872 B（159.0 MB） |
| SHA-256 | `ad69d4377ec11dc468fb117155a11a678314032144a13590616dfba477ddd906` |
| 打包源 | `D:\DeepSeekAgent`（含本次全部修复） |
| 归档条目 | 17,970（解压后 653,031,534 B） |

## 2. 用户反馈的三个问题

### 2.1 `D:\DeepSeekAgent` 无法启动（卡「正在启动 DSH Web 工作台」）

**根因（两层）**：

1. **直接根因**：`resources/packages/extensions/dsh-better-sidebar/node_modules/{schemastery,cosmokit}`
   被清成**空壳目录**（有目录无文件、无 `package.json`）。Node 模块解析"最近匹配优先"，
   空壳**遮蔽**了向上解析，使共享回退层 `<extensions>/node_modules` 失效 → cordis 插件树
   加载失败 → dsh web 秒退（exit code=1）→ exe 卡启动页。

2. **打包管线缺陷**：`_opt_flatten_deploy.mjs` 只处理 `resources/packages` 下的 junction，
   未处理 `dsh-runtime` 下**跨界**（指向 `resources/packages`）的 junction。makensis 完整
   打包 `dsh-runtime` 时会沿跨界链接进入 `packages/extensions` 的内部 `node_modules`，
   越过 `/x "node_modules"` 排除边界 → 火绒 EPERM → 构建中断（`.nsi` line 138）。

**修复**：
- 部署树层面：还原 schemastery 实体（从 `vendor/schemastery` v3.18.2）、补齐
  `app.asar.unpacked` 88 文件、清理 2 个跨界 junction。
- 管线层面（防复发）：
  - `_opt_flatten_deploy.mjs` 新增 `removeCrossingJunctions()`（dry-run 报告 + `--apply` 清理，
    带火绒 EPERM 提示）。
  - `_opt_payload_predict.mjs` 新增**跨界 junction 硬门禁**（存在即 `exit 3`）。
  - `_opt_flatten_deploy.mjs` 保留既有空壳自愈 `healHuskedPackages()`；predictor 保留空壳硬门禁。

### 2.2 外挂 `resources/node.exe`（88MB）是否必要

**结论：必要，不能去掉。** 原因：`dsh web` 由 `node --expose-internals <dsh>/lib/bin.js web`
启动，`@cordisjs/plugin-hmr` 需要真实的 `--expose-internals`（内部 ESM loader）。
Electron 内置 Node 以 `ELECTRON_RUN_AS_NODE=1` 运行时不暴露该内部 loader → dsh web 抛
`"--expose-internals is required for HMR service"` 秒退 → exe 永久卡在启动页。

`main.cjs` 的 `resolveBundledNode()` 优先级：`DSH_BUNDLED_NODE` → `resources/node.exe`
→ PATH 系统 node → 最后才用 Electron 内置 Node（仅排障兜底）。`pack-app-asar.mjs` 有
**版本硬门禁**：部署树 `node.exe` 必须是 v24.x（当前 v24.16.0），否则拒绝出包。

> 注：`resolveBundledNode()` 的注释里提到"Electron 44.1.1 内置 Node v24.18.1 已满足 dsh
> 运行时对 Node 版本的要求"，但**不满足 `--expose-internals` 的暴露行为**——两者是不同的
> 约束，外挂 node.exe 解决的是后者。

### 2.3 API Key 从系统环境变量读取（免费额度）

**实现**（`electron/main.cjs` → `buildDshWebBaseEnv()`）：

| 系统环境变量（用户提供） | 映射为 | 说明 |
| --- | --- | --- |
| `AI_DASHSCOPE_API_KEY` | `DEEPSEEK_API_KEY` | 百炼免费额度 |
| `ZHIPUAI_API_KEY` | `GLM_API_KEY` | 智谱免费额度（glm-4-flash 免费） |

**关键设计约束（重要）**：
- **只做 Key 名映射，绝不硬编码任何第三方端点**。provider 的 base URL 一律由用户的
  `settings.yaml` 决定（本机用户已配 `bailian` provider + 从系统环境变量取 Key）。
- 硬编码第三方端点会违反 `verify-default-models.mjs` 的纯净度门禁（把 aliyun/qwen/
  dashscope 列为 forbidden），并使 `_e2e_installer.mjs` 的 app.asar 端点审计失败。
- 映射仅在**更高优先级来源未提供**时兜底（UI 下发 Key > exe 旁 .env > 用户已配的原生名）。
- 这两个变量**不在** `stripInheritedCredentials` 剥离名单内；`DASHSCOPE_API_KEY` /
  `ALIYUN_API_KEYS` 等**仍在**剥离名单（安全行为，保留）。

## 3. 交付门禁

| # | 门禁 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 安装包载荷双向核对 | `verify-installer-payload.mjs`（7z ↔ 部署树） | **18/18 通过，0 失败** |
| 2 | 默认模型纯净度 | `verify-default-models.mjs` | **PASS**（`api.deepseek.com`，3 原生模型） |
| 3 | 载荷预测器 | `_opt_payload_predict.mjs` | **exit 0**（跨界 0 / 空壳 0） |
| 4 | asar 端点审计 | 精确正则扫 asar 内 code/json | **0 命中**（仅保留 Key 变量名） |
| 5 | asar 体内一致性 | 体内 `main.cjs` vs 源文件 | **字节一致** |

载荷核验里那条唯一历史 FAIL（`@lexical/history/src/index.ts`、`dsh-market/src/changelog.ts`）
已定性为**设计内排除**：`.ts` 源被 2026-09-17 新增掩码排除（cordis boot 探针实测启动加载
0 个 .ts）。已修正 `verify-installer-payload.mjs` 的 `CODE_EXT` 白名单（移除 `.ts/.tsx/
.mts/.cts`），并确认关键 JS（`dsh-market/lib/changelog.js`、`@lexical/history/dist/*.js`）
均在归档内。

## 4. 工具与流程改进

| 文件 | 变更 |
| --- | --- |
| `scripts/_patch-app-asar-main.mjs` | **新增**：外科式 asar 修补（extractAll → 覆盖 electron/** → 重打包 → 自检 → 部署）。解决全量 `pack-app-asar.mjs` 在火绒下需 40min+ 的问题；单文件修正秒级完成。带备份与字节一致性自检。 |
| `scripts/_opt_flatten_deploy.mjs` | 新增跨界 junction 检测/清理（`removeCrossingJunctions`，`--apply` 失败 `exit 5`） |
| `scripts/_opt_payload_predict.mjs` | 新增跨界 junction 硬门禁（`exit 3`） |
| `scripts/verify-installer-payload.mjs` | 修正 `CODE_EXT` 白名单，使断言与 `*.ts` 掩码设计一致 |
| `scripts/_e2e_installer.mjs` | `@deepseek-ai` 实体目录阈值 `>300` → `>200`（`/x "node_modules"` 瘦身后实体数为 270） |
| `electron/main.cjs` | Key 名映射（无端点）；注释同步说明产品契约 |

## 5. 验证方式与限制

- **本沙箱无法完成 GUI 终验**：无显示会话，Electron 主进程启动后常被进程组回收。
- **自动化 E2E 未跑完**：`_e2e_installer.mjs` 卡在 C 阶段（克隆 DSH_HOME 的 500+ junction），
  是火绒实时扫描导致的固有性能障碍，**非产品缺陷**。（已按用户指示改为真机测试。）
- **已完成的可信验证**：
  - 安装包本体：载荷双向核对 18/18、端点审计 0 命中、asar 体内一致性通过。
  - 部署树：`dsh web` 冒烟曾 PASS（带 token 的 ready URL）。
  - `main.cjs`：语法检查通过，逻辑已对照 `dsh-web-launcher.cjs` 契约确认。

## 6. 待用户执行

**真机 GUI 终验**（必须）：在桌面双击 `D:\DeepSeekAgent\DeepSeekAgent.exe`（或安装
`release/DeepSeekAgent-Setup-0.1.0.exe` 后双击），确认：
1. 不再卡在「正在启动 DSH Web 工作台」；
2. 工作台正常渲染；
3. 发一条消息，确认能用 `AI_DASHSCOPE_API_KEY` / `ZHIPUAI_API_KEY` 免费额度完成对话。

## 7. 后台任务收尾自检（新增工具）

针对"后台面板显示任务已运行 57 分钟"的排查，新增：

```bash
node scripts/_check_stale_tasks.mjs              # 报告 >30min 的本项目相关进程
node scripts/_check_stale_tasks.mjs --kill-stale # 报告并清理
```

**核查结论**：该 57 分钟任务**无底层进程存活** —— WorkBuddy 的 UI 任务卡片时长不刷新，
进程实际早在 TaskStop 时被杀。**判定僵尸任务必须以 OS 层进程为准**。

**收尾标准步骤**（每次任务结束执行）：
1. `TaskStop` 停掉本会话已无用的 background shell；
2. `node scripts/_check_stale_tasks.mjs --max-min 30` 复查是否有 >30min 的残留进程；
   有则 `--kill-stale` 清理（脚本带合法慢任务白名单，避免误杀大目录清理）；
3. 清理临时目录（`C:/temp/dsh-*`）与中间产物。
