# 三大问题修复报告（2026-09-10）

> 环境：`D:\DeepSeekAgent`（运行态） / `D:\WorkSpace\deepseek-harness-master`（源码）
> 结论：3 个问题均已定位根因并落地修复，且已部署到运行态。

---

## 一、结论速览

| # | 问题 | 根因 | 修复 | 状态 |
|---|------|------|------|------|
| 1 | 登录提示「限制访问」 | 内置浏览器用 **sandbox iframe（缺 `allow-same-origin`）** → 页面 `document.cookie`/`localStorage` 抛 `SecurityError` → 站点登录态/Cookie 全部不可用 | 给「浏览的网站」授予 `allow-same-origin`（保留 GUI 源与未授权回环地址的不透明沙箱） | ✅ 已修复并部署 |
| 2 | 沙箱模式点「百度一下」不触发查询 | 同上：沙箱缺 `allow-same-origin` 使百度页面出现**未捕获致命错误** → 搜索脚本崩溃 | 同上（`allow-same-origin`） | ✅ 已修复并部署 |
| 3 | 点「在浏览器中打开」却新开一个 DeepSeekAgent.exe 窗口 | 插件按钮是 `window.open(url,'_blank')`；Electron 主窗口**没有 `setWindowOpenHandler`** → 被当成新 BrowserWindow | 主窗口 + 插件工作台窗口都加 `setWindowOpenHandler` → `shell.openExternal(url)` | ✅ 已修复并部署（含 app.asar 重打包） |

---

## 二、证据链（实测，非推测）

### 1) 架构澄清：所谓「内置浏览器 / 沙箱模式」= `dsh-better-sidebar` 插件的浏览器标签页
- 渲染：`<iframe src={url} sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox" referrerPolicy="no-referrer">`
- 位置：`resources/packages/extensions/dsh-better-sidebar/lib/client.js`（及 `client-registry.js`）
- **注意**：这与 `dsh-bridge-browser`（真实 Chrome + DSH 扩展的 WebSocket 桥）是**两条完全不同的路径**。上次改的 Chrome 扩展 `content.ts` 与本问题无关。

### 2) Playwright 对照实验（三组 sandbox）
| 模式 | 百度页面控制台 |
|------|----------------|
| 现状（无 `allow-same-origin`） | ❌ **未捕获** `pageerror: Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag`；`SecurityError` @ `shouldSend`、`LocalCache.save` |
| + `allow-same-origin` | ✅ 上述错误全部消失（仅剩百度自身反嵌框检测） |
| 不沙箱 | ✅ 同 + `allow-same-origin` |

脚本：`scripts/_baidu_sandbox_probe.cjs`、`scripts/_baidu_sandbox_probe2.cjs`、`scripts/_baidu_top_vs_iframe.cjs`

### 3) 排除「百度反爬验证码」误判
`GET https://www.baidu.com/s?wd=test` 对**无会话/Cookie** 的请求会 `302 → wappass.baidu.com/.../captcha`。
判别实验证明：**顶层标签页与 iframe 都进验证码** → 该验证码是**自动化风控**触发，与 iframe 无关；真实浏览器不受影响。
→ 因此 Issue 2 的真凶就是 **`SecurityError` 打断页面 JS**，而非 iframe 本身。

---

## 三、改了什么

### 1) `dsh-better-sidebar`：给浏览站点补 `allow-same-origin`
**逻辑**（`iframeSandboxFor`）：
```
GUI 自身源        → 不透明沙箱（绝不与父窗口同源）
未授权 回环地址    → 不透明沙箱（防远端页面借帧访问本地服务）
其余（含所有公网站点）→ 追加 allow-same-origin（获得自身源：Cookie/Storage/表单令牌正常）
```
安全性：`allow-same-origin` 只给页面**自己的源**，它仍与 GUI 及所有其它站点跨源，读不到 GUI 存储/API；`allow-top-navigation` 依旧不给，无法劫持 GUI。

| 文件 | 变更 |
|------|------|
| 源码 `packages/extensions/DSH-better-sidebar-0.18.1/src/client/BrowserView.tsx` | 重写 `iframeSandboxFor` + 导入 `isLoopbackHostname` + 注释说明 |
| 部署态 `…/dsh-better-sidebar/lib/client.js` | 同逻辑（最小化改动） |
| 部署态 `…/dsh-better-sidebar/lib/client-registry.js` | 同上（该文件也含同一函数副本） |

### 2) Electron 主进程：`window.open` → 系统浏览器
`apps/agent-client/electron/main.cjs`，两处窗口均新增：
```js
win.webContents.setWindowOpenHandler(({ url }) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url)
  return { action: 'deny' }
})
```
（`createMainWindow` 主窗口 + `createPluginWorkbenchWindow` 插件工作台窗口）

### 3) 关键坑：asar 内零 `unpacked` 条目 → 必须重打包
- 部署态 `resources/app.asar` 头部 **unpacked 条目 = 0**，`main.cjs` 从 **asar 内部**加载；
  `resources/app.asar.unpacked/electron/main.cjs` 只是**遗留副本**，改它**不生效**。
- 因此新增 `scripts/_repack_app_asar.mjs`：解包现有 asar → 覆盖 `electron/main.cjs`（补丁版）→ 重打包（`dot:true`，保留 `.bin/.pnpm`）→ 校验 → 备份并部署到 `D:/DeepSeekAgent/resources/app.asar` 与仓库 `apps/agent-client/app.asar`。

---

## 四、部署与验证结果

```
[Issue 3] 部署态 asar/electron/main.cjs  setWindowOpenHandler = 2  ✅（含 shell.openExternal）
[Issue 2] 部署态 lib/client.js          sandboxHost 命中 = 3      ✅
[Issue 2] 部署态 lib/client-registry.js sandboxHost 命中 = 3      ✅
[Issue 2] 源码 BrowserView.tsx          SAME_ORIGIN 引用 = 2      ✅
asar 体积 37,755,415 → 37,756,097（+682B）顶层结构 apps/electron/node_modules/package.json 不变 ✅
备份：client.js / client-registry.js → *.bak-20260910；app.asar → app.asar.bak-<ts> ✅
```

---

## 五、如何自行验证 / 调试

1. **重启 DeepSeekAgent**（asar 与插件均在启动时加载），侧边栏开浏览器标签 → 打开 `https://www.baidu.com/`。
2. **F12 Console**：不再出现 `The document is sandboxed and lacks the 'allow-same-origin' flag`。
3. 输入关键词点「百度一下」→ 应正常发起 `/s?wd=...` 请求（Network 面板可见）。
4. **点右上角链外图标「在浏览器中打开」** → 应打开系统默认浏览器，而**不再**新开 DeepSeekAgent 窗口。
5. 若仍异常：
   - `curl http://127.0.0.1:5283/ext/bridge-config` 看桥是否在线；
   - 侧边栏地址栏对 `localhost/127.0.0.1` 默认被拦（`browserAllowedLoopback` 为空），若需访问本地服务需在设置里把地址加入白名单。

---

## 六、已知边界与建议（后续项）

1. **`X-Frame-Options` / `frame-ancestors` 站点**（部分站点禁止被任何 iframe 嵌入）仍无法在侧边栏内显示——这是 iframe 方案的硬限制。插件已提供「在浏览器中打开 / 仍然加载」兜底；本次修复让前者真正可用。
2. **`allow-same-origin` 的残留理论风险**：远端页面若能把自己的帧导航到 *GUI 自身源*，则可能与父窗口同源。当前 GUI 源分支仍返回不透明沙箱，但**帧内导航无法被父页面感知**，故存在理论窗口。彻底方案是把内置浏览器从 `<iframe>` 换成 **Electron `<webview>` / `WebContentsView`**（顶层浏览上下文，不受 X-Frame-Options 影响，天然第一方 Cookie）。建议作为下一阶段改进。
3. **安装包未重打**：本次只更新了运行态（`D:\DeepSeekAgent`）。若要让 NSIS 安装包 `DeepSeekAgent-Setup-0.1.0.exe` 带上修复，需按既有流程重跑打包（且应先过全部自动化测试）。
4. 插件为社区第三方（`DSH-better-sidebar-0.18.1`），**插件升级会覆盖**本次部署态改动；源码已同步修改，升级后需重新构建/打补丁。

---

## 七、改动文件清单

| 文件 | 说明 |
|------|------|
| `apps/agent-client/electron/main.cjs` | 两处 `setWindowOpenHandler` |
| `packages/extensions/DSH-better-sidebar-0.18.1/src/client/BrowserView.tsx` | 源码修复 |
| `D:/DeepSeekAgent/resources/packages/extensions/dsh-better-sidebar/lib/client.js` | 部署态修复 |
| `D:/DeepSeekAgent/resources/packages/extensions/dsh-better-sidebar/lib/client-registry.js` | 部署态修复 |
| `D:/DeepSeekAgent/resources/app.asar` + `apps/agent-client/app.asar` | 重打包（含 main.cjs 修复） |
| `scripts/_repack_app_asar.mjs` | 新增：asar 解包→替换→重打包→校验→部署 |
| `scripts/_baidu_sandbox_probe*.cjs`、`_baidu_top_vs_iframe.cjs` | 新增：根因对照实验 |
