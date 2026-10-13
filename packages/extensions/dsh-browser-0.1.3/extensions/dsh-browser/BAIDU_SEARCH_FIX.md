# 内置浏览器（dsh-bridge-browser）百度搜索“百度一下”无法触发查询 — 排查与修复

## 现象
在受控 Chrome 标签页打开 `https://www.baidu.com`，用 `browser_type` 在搜索框输入文字、再 `browser_click` 点“百度一下”（`#su`，本质是一个 `<input type="submit">`），页面不跳转、不出现搜索结果——“没有触发查询”。

## 根因（已定位）
`dsh-bridge-browser` = 节点侧插件 + Chrome 扩展两侧。**真正的点击/输入发生在 Chrome 扩展的内容脚本里**（`packages/extensions/dsh-browser-0.1.3/extensions/dsh-browser/src/content/actions.ts`），节点插件只负责转发。

原 `clickAction` / `pressAction` 的提交逻辑有两个缺陷：

1. 🥇 **不可信（untrusted）点击不提交表单**
   点击提交控件走的是 `(el as HTMLElement).click()`。这是**合成点击**，产生的 `click` 事件 `isTrusted === false`。百度等站点把“发起搜索”挂在“受信任的用户激活”之上，合成点击会被忽略，表单不提交、页面不动。
2. **`pressAction` 的回车处理是死路**
   原代码 `target.form.dispatchEvent(new Event('submit', ...))` 只是**派发一个合成 submit 事件**——它只触发监听器，**永远不真正提交/跳转**。所以即便改用回车也搜不了。

> 注：Baidu 搜索框 `#kw`（`name="wd"`）用 `setNativeValue` 赋值并派发 `input`/`change`，值是正确写入的；问题不在输入，而在“提交”这一步被合成事件卡住。

## 修复（已落地于源码）
文件：`src/content/actions.ts`

- `clickAction`：当点击目标是表单提交控件（`button[type=submit]` / `input[type=submit|image]`）时，改为走新的 `submitSearchForm()`，分三层兜底，保证一定提交：
  1. 原生 `el.click()`（让站点 JS / onsubmit 先跑）；
  2. `form.requestSubmit(submitter)`（跑校验 + submit 事件，绕过部分 isTrusted 限制）；
  3. **强制 `form.submit()`**（完全绕过 onsubmit / isTrusted，必定跳转；GET 表单直接拼出 `action?wd=...`）。
- `pressAction` 的回车分支：同样改为 `form.requestSubmit(target)` → 失败再强制 `form.submit()`，不再派发无效的合成 submit 事件。

> 兜底第 3 层用 `setTimeout(... form.submit(), 0)` 并标记 `navigationPending:true`，与 `browser_navigate` 的卸载处理一致，避免内容脚本在 await 前被卸载丢失响应。

## 验证
- 已用 esbuild 重新打包 `src/content/index.ts` → `dist/content.js`（41.3 kB）。
- 产物中确认包含 `submitSearchForm` / `requestSubmit` / `formActionUrl`，且旧的 `dispatchEvent(new Event('submit'` 死路已被移除（0 处）。

## 部署（二选一）

### A. 快速热替换（只动了 content 脚本）
1. 用本仓库打包好的 `dist/content.js` 替换你**已加载的扩展目录**里对应的 `content.js`。
2. 打开 `chrome://extensions` → 找到 DeepSeek/dsh 扩展 → 点“重新加载”(Reload)。
3. 在 dsh web 侧栏对该百度标签页重新 `browser_snapshot` → `browser_type` → `browser_click` 百度一下，应正常出结果。

### B. 干净全量重建（推荐，避免环境差异）
```bash
cd packages/extensions/dsh-browser-0.1.3/extensions/dsh-browser
pnpm install          # 或 npm install
pnpm build            # 顺序构建 background / content / panel → dist/
# 然后 chrome://extensions 里重新“加载已解压的扩展程序”指向 dist/
```
（本沙箱缺该包的本地 node_modules，无法在内部跑 `pnpm build`；已改用 esbuild 直接产出 content 产物供方案 A 使用。）

## 自行调试 / 排查方法
1. **看网络请求（最直接）**：在受控百度标签页按 F12 → Network，过滤 `s?wd=`。点“百度一下”后——
   - 出现 `https://www.baidu.com/s?wd=...` 请求 ⇒ 搜索已触发，问题在别处；
   - 完全没有该请求 ⇒ 点击确实没提交（修复前应如此，修复后应有）。
2. **看控制台**：Console 是否有 CSP / 扩展报错；确认扩展已连接——节点侧 `curl http://127.0.0.1:5283/ext/bridge-config` 应返回 `{ wsUrl }`。
3. **确认快照里有按钮索引**：`browser_snapshot`，在搜索框附近应能看到一个 `submit` 类型的可交互项（即“百度一下”），记下它的 index 再 `browser_click`。
4. **换输入框回车**：现 `browser_press` key=`Enter` 已修好，可作为点按钮的等价验证。
5. **兜底直跳验证链路**：直接 `browser_navigate` 到 `https://www.baidu.com/s?wd=你的关键词`。若这样能出结果，说明桥/智能体链路正常，问题只在于“点击提交”这一步（即本次修复点）。
