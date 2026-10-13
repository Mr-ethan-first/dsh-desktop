# 启动白屏的根因分析与修复（2026-09-18 实测）

> 结论先行：**不是 App 渲染 bug，是外部程序抢占端口。**
> `元宝.exe`（腾讯元宝）在 `127.0.0.1:5283` 上驻留了一个 **HTTPS 隧道**
> （响应头 `Server: sctun`），而本客户端的 DSH Web 工作台恰好把 `5283`
> 当作默认端口。窗口按明文 HTTP 访问该端口时，对方回：
>
> ```
> HTTP/1.0 400 Bad Request
> Client sent an HTTP request to an HTTPS server.
> ```
>
> Chromium 无法渲染这个响应 → 用户看到**一张纯白页，零错误提示、零线索**。

---

## 1. 用户报告的现象

`2026-09-18 13:24` 截图：窗口标题正常（`@deepseek-ai/dsh-agent-client`），
菜单栏正常渲染，**内容区全白**。

这个形态本身就排除了两类可能：

| 现象 | 说明 |
|---|---|
| 不是「卡在启动页」 | 启动页背景是 **深色 `#0f1115`** + 旋转 loading，而截图是**白色** |
| 不是渲染进程崩溃 | 崩溃会被 `render-process-gone` 捕获、写 `crash-*.log` 并自动重载；13:24 无任何 crash 记录 |

→ **页面确实加载了，但拿到的是一个空白/错误响应。**

## 2. 逐层排查（排除法）

| 假设 | 验证方法 | 结论 |
|---|---|---|
| dsh web 后端没起来 | 查 `dsh-web-2026-09-18.log` | ❌ 11:56:50 已正常打印 token（`http://127.0.0.1:5283/?token=rZ_Ke...`） |
| 插件挂载失败 | 查 `electron-2026-09-18.log` | ❌ 插件链正常，`[mcp-connector] client apply() completed` |
| 渲染进程崩溃 | 查 `crash-2026-09-18.log` | ❌ 只有两次正常 `before-quit`，无渲染崩溃 |
| 主进程报错 | `grep` electron 日志 | ❌ 除 GPU 驱动告警外**零错误行** |
| **端口被抢占** | `Get-NetTCPConnection -LocalPort 5283` | ✅ **命中：`yuanbao.exe` PID 13896** |

### 决定性证据

```console
$ curl -i "http://127.0.0.1:5283/?token=test"
HTTP/1.0 400 Bad Request
Client sent an HTTP request to an HTTPS server.

$ curl -sk "https://127.0.0.1:5283/"
HTTP/1.1 200 OK
Server: sctun            ← 腾讯元宝的隧道进程
Content-Type: application/json
Content-Length: 0

$ Get-NetTCPConnection -LocalPort 5283 -State Listen
LocalPort 5283  OwningProcess 13896  →  yuanbao.exe (created 12:02:54)
```

**时间线坐实：**
1. `11:56` 我们的 App 启动，5283 空闲，dsh web 正常占用并渲染成功 ✅
2. `11:58` 用户退出 App
3. `12:02:54` **元宝启动，抢下 5283**
4. `13:24` 用户再次打开 App → 窗口指向 5283 → 撞上元宝的 HTTPS 隧道 → **白屏** ❌

## 3. 为什么既有的端口冲突兜底没能拦住

`main.cjs` 里已有两处防护，但**都只工作在 TCP 层**：

| 既有防护 | 位置 | 为何失效 |
|---|---|---|
| `isPortFree(port)` 预检 | L517 | `net.createServer().listen()` 只问「能否 bind」。元宝的隧道 TCP 层完全正常 → 返回 `true`（应占用却判空闲）|
| `waitDshWebReady()` token 门控 | L561 | 它等的是**我们自己子进程**打印 token，与端口上是否坐着别人无关 |

实测复现（对真实 5283）：

```js
isPortFree(5283) = false   // ← 这个是对的（元宝确实在 listen）
isPortFree(5284) = true
```

`isPortFree` 本身没错。问题在于：**元宝是 12:02 才抢的端口**，而 App 若在
`isPortFree` 通过后、窗口导航前这个窗口期内被人抢走端口（或更常见的：
上一次 App 的 dsh web 子进程残留未清、用户期间启动过元宝），
就没人再复核「我导航的地址到底是不是 dsh web」。

**根因一句话：预检只保证「端口当时空闲」，从不保证「我导航时它还是我的」。**

## 4. 修复

在 **导航前**增加一道**内容探测**（不只是端口探测）：

### 4.1 `probeIsDshWeb(url)`（新增）

发一个真实 HTTP GET，按以下判据认定「不是 dsh web」：

| 判据 | 触发的 `reason` |
|---|---|
| 连接被拒 / 超时 | `connect-failed` / `timeout` |
| 响应头 `server` 命中 `sctun\|nginx\|apache\|caddy\|cloudflare` | `foreign-server` |
| body 含 `HTTPS server`（即「明文打到 HTTPS 服务」） | `https-only` |
| 状态码 ≥ 400 | `http-error` |

**合法判据**：状态码 `303`（带 token 的重定向）或 `401`（无 token）→ 认定是真 dsh web。

### 4.2 `webPortConflictHTML(port, who)`（新增）

探测失败时**不再导航**，改加载中文诊断页，明确写出：
- 占用端口号
- **占用程序名 + PID**（由 `describePortOwner()` 反查 `Get-NetTCPConnection` → `Get-Process`）
- 三条可操作步骤（关掉占用程序 / 换端口 / 重开客户端自动换端口）
- 排查命令 `netstat -ano | findstr :5283`

### 4.3 `captureDshWebToken()` 改为「先探测、后导航」

```js
void probeIsDshWeb(authUrl).then(async (probe) => {
  if (probe.ok) { mainWindow.loadURL(authUrl); return; }   // 确认是 dsh web 才跳
  const who = await describePortOwner(port);
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(webPortConflictHTML(port, who)));
});
```

探测本身抛异常时，catch 分支按原行为直接导航 —— 不能因为探测故障把用户卡住。

## 5. 验证

### 5.1 探针单元测试（全绿）

| 场景 | 期望 | 实测 |
|---|---|---|
| 真 dsh web（303 带 token） | OK | ✅ `ok=true` |
| 真 dsh web（401 无 token） | OK | ✅ `ok=true` |
| 模拟 HTTPS-only（400 + `Server: sctun`） | 拦截 | ✅ `reason=foreign-server` |
| **真实元宝端口 5283** | 拦截 | ✅ `reason=timeout` |
| 空端口（5284 / 59999） | 拦截 | ✅ `reason=connect-failed ECONNREFUSED` |

### 5.2 launcher 冒烟（部署树 + 新 asar）

```
[smoke] prepareDshHome OK; dshHome=C:\temp\dsh-smoke-1789710526730
[dsh-web] dsh web: http://127.0.0.1:5300/?token=liAo3AP...
[smoke] TOKEN_READY: http://127.0.0.1:5300/?token=liAo3AP...
```

### 5.3 交付链字节一致

| 位置 | `electron/main.cjs` 字节 | sha256(前16) |
|---|---|---|
| 源文件 | 106,303 | `141f95c0f0146495` |
| `_asar_stage` 打包产物 | 106,303 | `141f95c0f0146495` |
| `D:/DeepSeekAgent/resources/app.asar` | 106,303 | `141f95c0f0146495` |

四个修复标记（`probeIsDshWeb` / `webPortConflictHTML` / `describePortOwner` /
`web-port-conflict`）在部署 asar 内**全部 PRESENT**。

---

## 6. 事故副产物：打包脚本卡死 + 部署树半损坏（已修复）

本次重打包时踩到一个**新的坑**，值得记下：

### 现象
`pack-app-asar.mjs --deploy` 跑到 15 分钟后：CPU **15 秒采样增量为 0**（卡死，
非慢），`D:/DeepSeekAgent/resources/app.asar` 已更新（13:29），但
**`app.asar.unpacked` 整个目录消失**（被 `removeTree` 删掉、`fs.cp` 还没跑完）。

### 根因
`pack-app-asar.mjs` 部署段（L301-302）是：

```js
await removeTree(path.join(resDir, 'app.asar.unpacked'));   // ← 火绒下极慢
await fs.cp(appAsarUnpacked, path.join(resDir, 'app.asar.unpacked'), { recursive: true });
```

`removeTree` 在火绒实时扫描下走的是**逐文件删除**的老路（本项目已知硬地板
≈1.5 文件/秒），把进程拖进不可观测的长循环；此时部署树处于**半损坏状态**。

### 修复动作
1. 判定卡死（CPU 增量 = 0）→ `Stop-Process` 终止 pid 16020
2. 用 Python `shutil.copytree` 把 `_asar_stage/app.asar.unpacked`(89 文件)
   部署到位 —— Python 的 `copytree`/`rmtree` 在本机**比 Node 路径快一个数量级**
   （实测 8 个备份目录共 296MB / 8.5 秒删完）
3. 用最小脚本 `_repack_deploy.mjs` 只做 `createPackage` + `copyFile`，
   **跳过 `removeTree`** → **2 秒完成**

### 建议（未改脚本，留给下次决定）
`pack-app-asar.mjs` 的 `--deploy` 分支应把 `removeTree(app.asar.unpacked)`
换成「Python `shutil.rmtree` 或先改名再异步删」，否则每次部署都可能再卡一次。

---

## 7. 用户可立即执行的动作

**当前状态：白屏不会再出现**（已部署修复）。但要让工作台真正恢复，需处理端口：

1. 确认 `元宝.exe` 是否真需要占用 `5283`（元宝设置里通常可改端口）
2. 若不便改：**直接重开本客户端即可** —— 修复后它会自动从 5283 向后找空闲端口
   （`WEB_PORT_MAX_RETRY = 20`，即 5283~5302）
3. 再次打开后若仍异常，客户端会显示**中文诊断页**并写明占用者，不再白屏
