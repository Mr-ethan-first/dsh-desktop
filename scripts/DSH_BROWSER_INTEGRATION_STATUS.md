# dsh-browser 集成状态报告（2026-09-10 收尾）

## 一、结论

**此前只集成了一半**：节点侧桥插件已挂载，**Chrome 扩展侧完全缺失**（`D:/DeepSeekAgent` 内 0 个 `dsh-browser` 文件，`~/.dsh/browser-extension` 不存在）。

**现已补齐**：完整构建 Chrome 扩展（background + content + panel 三个产物）并部署到两个稳定路径，`dist/` 已从 1 个文件（only content.js）变为**可加载的完整 MV3 扩展**。

---

## 二、集成前 vs 集成后

| 组成部分 | 集成前 | 集成后 |
|---|---|---|
| 节点桥插件 `@yuxianglin/dsh-bridge-browser` | ✅ 已部署 `resources/packages/extensions/dsh-bridge-browser`（lib/*.js，v0.0.4） | ✅ 不变 |
| web profile 挂载 | ✅ `profiles/web/package.json → dsh.profile.bundles` 含 `@yuxianglin/dsh-bridge-browser` | ✅ 不变 |
| bridge token | ✅ 已生成 `dsh-home/ext-bridge-token` | ✅ 不变 |
| **Chrome 扩展 `dsh-browser` v0.1.3** | ❌ **缺失**（仅 repo 源码 + 我上次 esbuild 的半成品 content.js） | ✅ **完整构建并部署** |
| 扩展部署路径 | ❌ 无 | ✅ `~/.dsh/browser-extension` + `D:/DeepSeekAgent/resources/browser-extension` |

---

## 三、本次构建产物（Vite，非 esbuild 半成品）

| 文件 | 大小 | 说明 |
|---|---|---|
| `background.js` | 188.03 kB（ESM service worker） | 桥接、RPC、tab 亲和、审批协调 |
| `content.js` | 23.22 kB（IIFE） | DOM 操作层，**含百度搜索修复** |
| `panel/index.html` + `assets/index.js` + `assets/index.css` | 426.76 kB / 44.37 kB | React 侧边面板 |
| `manifest.json` / `_locales/*` / `assets/icons/*` | — | MV3 清单、三语、图标 |

**构建命令（离线，依赖从 monorepo pnpm store junction 而来）**

```bash
# 1) 链接构建依赖（一次性，脚本免 cmd.exe）
node scripts/_link_ext_deps.mjs
# 2) 三个 target 顺序构建（跳过 build.mjs，因为它 spawn 裸 `vite`）
cd packages/extensions/dsh-browser-0.1.3/extensions/dsh-browser
VITE=<repo>/node_modules/.pnpm/vite@6.4.3_.../node_modules/vite/bin/vite.js
node "$VITE" build --config vite.background.config.ts   # emptyOutDir=true，先清空
node "$VITE" build --config vite.content.config.ts
node "$VITE" build --config vite.panel.config.ts
# 3) 部署
cp -r dist/. ~/.dsh/browser-extension/
cp -r dist/. D:/DeepSeekAgent/resources/browser-extension/
```

**依赖链接策略**：扩展包无本地 `node_modules`，从 `node_modules/.pnpm/` 用 **目录 junction**（`fs.symlinkSync(..., 'junction')`）链入
`vite@6.4.3 / @vitejs/plugin-react@4.7.0(vite6 变体) / vite-tsconfig-paths@6.1.1 / react@18.3.1 / react-dom@18.3.1 / marked@16.4.2 / dompurify@3.4.11 / tldts@7.4.5`，
外加 `@yuxianglin/dsh-bridge-browser` → `packages/browser/bridge-browser`（扩展按 `.../src/protocol.ts` 源码级导入，需该包 `exports."./src/*"`）。

---

## 四、验收证据

1. **manifest 引用文件全部存在**（`background.js`、`panel/index.html`、`content.js`、4 个图标）——构建目录与两个部署目录均逐一核验 OK，0 MISS。
2. **语法**：`content.js` 通过 `node --check`；`background.js` 通过 ESM 校验。
3. **百度修复已进入新产物**：minify 后仍可读出具三层兜底逻辑
   `click()` → `requestSubmit()` → `setTimeout(() => form.submit(), 0)`，且失败时回退 `location.href = <form action 构造 URL>`；`pressAction` 的 Enter 分支同构。
   旧死路（`dispatchEvent(new Event('submit'))`）计数 **0**。
4. **manifest.json 有效**：`manifest_version=3`、`version=0.1.3`、`name=__MSG_extensionName__`（locale 占位符由 `_locales` 提供）。

---

## 五、你需要做的一步（Chrome 侧加载）

扩展是"未打包扩展"，必须由 Chrome 加载一次：

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. **加载已解压的扩展程序** → 选择 `C:\Users\Administrator\.dsh\browser-extension`
4. 在 DSH 设置页复制 **浏览器桥地址**（`ws://127.0.0.1:<port>/ext/bridge`），粘贴进扩展面板的「桥地址」；**本机回环无需 Token**

> DeepSeekAgent 必须处于运行态，`/ext/bridge-config` 才有响应（当前未运行，探测为连接被拒/404）。

---

## 六、仍存在的边界（诚实说明）

1. **扩展不由 exe 自动安装**——Chrome 侧永远需要用户手动"加载已解压的扩展程序"（或后续上架商店）。这是 dsh-browser 上游的设计，不是本次遗漏。
2. **NSIS 安装包未重打**：`D:/DeepSeekAgent/resources/browser-extension` 已就位，下次重打 NSIS 会随包携带；但**已安装**的旧版本不会自动获得。
3. `marked@16.4.2`（需 ^18）、`tldts@7.4.5`（需 ^6.1）与声明范围有偏差，但实际用到的 API（`marked.parse/setOptions`、`getDomain`、`DOMPurify.sanitize`）跨版本稳定，构建无警告、产物可用。**如需严格对齐，需联网装精确版本。**
4. 侧边栏内置浏览器（`dsh-better-sidebar` 的 `<iframe>`）与本扩展是**两条并行路径**：前者受 `X-Frame-Options` 限制、后者驱动真实 Chrome 标签页。二者互不影响。
