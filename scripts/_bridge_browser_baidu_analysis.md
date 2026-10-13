# dsh-bridge-browser 内置浏览器访问百度后故障分析

## 一、架构澄清（重要）

**「内置浏览器」不是 Electron 内嵌的 BrowserWindow，而是你本机 Chrome 浏览器 + DSH Chrome 扩展**，通过 WebSocket 桥接到 dsh web 后端。

```
┌──────────────────────┐         WebSocket (/ext/bridge)         ┌──────────────────────┐
│  DeepSeekAgent.exe   │  ◄═══════════════════════════════►  │  Chrome + DSH Extension │
│  ┌─ DSH Web UI      │   Token Auth / RPC / Tool Call       │  ┌─ Content Script    │  │
│  ├─ dsh web backend  │                                       │  ├─ Snapshot Capture │  │
│  └─ bridge-browser   │                                       │  └─ Page Navigation  │  │
└──────────────────────┘                                       └──────────────────────┘
        ↑                                                              ↓
        │                                                        ┌──────────┐
        │                                                        │ Baidu.com │ ← 故障触发点
        │                                                        └──────────┘
        └─── port 5283 (dsh web) ────────────────────────────────────┘
```

## 二、故障根因分析（按概率排序）

### 🔴 #1（最可能）百度 CSP 阻止 Content Script 执行

百度返回严格的 `Content-Security-Policy` 头，可能阻止扩展的 content script 注入：

```bash
# 验证方法：在 Chrome 地址栏访问百度后按 F12，看 Console 是否有 CSP 相关错误
# 预期错误：
# Refused to execute inline script because it violates the following Content Security Policy directive: ...
# 或者扩展的 content script 根本没有执行（无 console 输出）
```

**影响链路**：CSP 阻止 script → content script 不执行 → 无法捕获页面快照 → bridge 收不到 snapshot → Agent 认为浏览器「不可用」

### 🟠 #2 百度反爬/自动化检测

百度有较强的反爬机制，可能检测到 Chrome 扩展的自动化行为：
- 检测 `chrome.runtime` API 调用
- 检测 DOM 遍历特征
- 触发验证码/跳转 → 页面状态异常 → snapshot 内容为空或错误页

### 🟡 #3 快照捕获超时（DOM 过大）

百度首页 DOM 极其复杂（数千节点），`snapshotMaxChars: 32000` 可能不够用，导致：
- 快照截断 → Agent 收到不完整上下文
- 捕获耗时超过 `toolTimeoutMs: 90000`（90s）→ bridge 报 timeout

### 🟢 #4 WebSocket 连接断开

百度页面可能通过某种方式触发扩展重启或导航，导致 WS 断开：
- 扩展 background service worker 被 Chrome 挂起
- 页面导航触发扩展重新注入失败

## 三、自行调试方案（5 步）

### Step 1：确认 Bridge 服务端状态

```bash
# 在终端执行（dsh web 必须在运行）
curl -s http://127.0.0.1:5283/ext/bridge-config
# 预期返回：{"wsUrl":"ws://127.0.0.1:5283/ext/bridge"}
# 若连接被拒 → dsh web 未运行，先启动 DeepSeekAgent.exe
```

### Step 2：Chrome 扩展控制台排查（最关键）

1. 打开 Chrome，访问任意页面
2. 按 `F12` 打开开发者工具
3. 切换到 **Console** 面板
4. 观察 DSH 扩展相关的日志/错误：
   - 正常时应看到 `[DSH Bridge]` 前缀的日志
   - 若有红色错误，截图记录
5. **关键测试**：访问百度前后的 Console 输出对比

```javascript
// 在 Console 中手动检查扩展是否存活
chrome.runtime?.sendMessage({type:'ping'}, r => console.log('Extension alive:', r))
// 若报错 "Could not establish connection" → 扩展已崩溃/卸载
```

### Step 3：对比测试（隔离变量）

| 测试页面 | 预期结果 | 结论 |
|---------|---------|------|
| `about:blank` | 正常 | 扩展本身 OK |
| `https://www.google.com` | 正常 | 非百度站点 OK |
| `https://www.baidu.com` | 失败 | **百度特有问题** |
| `https://www.bing.com` | 正常 | 排除中文站点问题 |

若仅百度失败 → 确认为百度兼容性问题（CSP 或反爬）

### Step 4：检查 CSP 响应头

```bash
curl -sI https://www.baidu.com 2>/dev/null | grep -i "content-security-policy"
# 若有输出，说明百度启用了 CSP
# 对比：
curl -sI https://www.google.com 2>/dev/null | grep -i "content-security-policy"
# Google 通常不返回 CSP（或更宽松）
```

### Step 5：查看 Bridge 服务端日志

```bash
# dsh web 运行时的日志中搜索 bridge 相关条目
grep -i "bridge\|browser\|ext/" D:/DeepSeekAgent/logs/*.log 2>/dev/null | tail -30
# 或看我们之前的 serve 日志
tail -100 _tmp_dsh_serve.log 2>/dev/null | grep -iE "bridge|error|fail|close|timeout"
```

## 四、解决方案

### 方案 A：扩展配置白名单（推荐）

如果 Chrome 扩展代码可修改，在 `manifest.json` 的 `content_scripts.matches` 中确保包含百度：

```json
{
  "content_scripts": [
    {
      "matches": ["<all_urls>", "https://*.baidu.com/*", "http://*.baidu.com/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

### 方案 B：增大快照超时和字符限制

编辑 `D:/DeepSeekAgent/resources/packages/extensions/dsh-bridge-browser/cordis.patch.yml`：

```yaml
- insert:
    - id: bridge-browser
      name: '@yuxianglin/dsh-bridge-browser'
      config:
        toolTimeoutMs: 180000        # 90s → 180s（百度 DOM 大）
        snapshotMaxChars: 64000      # 32K → 64K
        maxInteractiveItems: 100     # 60 → 100
```

### 方案 C：绕过百度（临时 workaround）

在 DSH Web UI 的设置中将浏览器桥接目标改为其他搜索引擎，避免直接访问百度。

### 方案 D：Chrome 启动参数放宽安全策略

如果自己打包 Chrome 或有启动器，添加：

```bash
chrome.exe --disable-web-security --user-data-dir=/tmp/chrome-debug
```
⚠️ 仅用于调试，不要用于日常浏览（关闭同源策略）。

## 五、需要你提供的信息

为了进一步精确定位，请提供：

1. **截图内容描述**：你在哪个界面看到「内置浏览器」？是：
   - [ ] DSH Web UI 内的某个 iframe/webview？
   - [ ] 独立的 Chrome 窗口（有 DSH 扩展图标）？
   - [ ] Electron 应用内的某个「打开浏览器」按钮弹出的窗口？

2. **Chrome F12 Console 截图**：访问百度后的 Console 错误信息

3. **具体症状**：「无法使用」的表现是：
   - [ ] 页面白屏/空白？
   - [ ] DSH Chat 里发消息无响应？
   - [ ] Chrome 扩展图标变灰/消失？
   - [ ] 报错提示（贴原文）？
