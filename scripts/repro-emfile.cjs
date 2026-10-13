/**
 * EMFILE 根因复现脚本（纯 Node，无 Electron 依赖）。
 *
 * 目标：证明 main.cjs 的 handleProxy 在「上游 API 不可达/挂起」时，
 * 因 https.request 没有超时、也没有在客户端断开时 abort，
 * 会累积无限增长的 socket 句柄 → 最终 EMFILE。
 *
 * 用法：
 *   node scripts/repro-emfile.cjs            # 同时演示 buggy 与 fixed 两种模式
 *   node scripts/repro-emfile.cjs --buggy    # 只演示当前（有 bug）模式
 *   node scripts/repro-emfile.cjs --fixed    # 只演示修复后模式
 */
'use strict'
const http = require('http')
const net = require('net')

const N = 200 // 模拟连续发送 200 条聊天消息（每条走一次 /zhipu 代理）

//  unbiased 备选计数：若运行时暴露了内部句柄接口就用它，否则回退到自计数
function internalActiveSockets() {
  try {
    const f = process._getActiveHandles || process.getActiveHandles
    if (typeof f !== 'function') return null
    const handles = f.call(process)
    let n = 0
    for (const h of handles) if (h instanceof net.Socket) n++
    return n
  } catch {
    return null
  }
}

function openCount(reqs) {
  let n = 0
  for (const r of reqs) {
    const s = r.socket
    if (s && !s.destroyed) n++
  }
  return n
}

async function main() {
  // 1) 起一个「挂起的上游」：接受 TCP 连接，但永远不回 HTTP 响应
  const upstream = net.createServer((sock) => {
    /* 不写数据、不 end、不 destroy —— 一直挂着 */
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const upstreamPort = upstream.address().port
  const target = `http://127.0.0.1:${upstreamPort}/chat/completions`

  const mode = process.argv[2] || 'both'
  if (mode === 'both' || mode === '--buggy') {
    await runScenario('BUGGY（当前 handleProxy 写法：无超时/无断连 abort）', target, false, 1500)
  }
  if (mode === 'both' || mode === '--fixed') {
    await runScenario('FIXED（up.setTimeout(700) 回收空闲上游）', target, true, 1600)
  }

  upstream.close()
  setTimeout(() => process.exit(0), 400)
}

async function runScenario(label, target, fixed, waitMs) {
  console.log('\n================ ' + label + ' ================')
  const before = internalActiveSockets()
  const reqs = []
  for (let i = 0; i < N; i++) reqs.push(fireOne(target, fixed))
  const establishedImmediately = openCount(reqs)
  await new Promise((r) => setTimeout(r, waitMs))
  const after = openCount(reqs)
  const internalAfter = internalActiveSockets()
  console.log(`  发起请求数            : ${N}`)
  console.log(`  建立连接后 open socket : ${establishedImmediately}`)
  console.log(`  ${waitMs}ms 后 open socket : ${after}`)
  if (before !== null) console.log(`  进程级 socket 句柄(前/后): ${before} / ${internalAfter}`)
  const leaked = after >= N * 0.8
  console.log(`  => ${leaked ? '❌ 句柄随请求线性累积（泄漏，最终 EMFILE）' : '✅ 空闲句柄已被回收（无泄漏）'}`)
  for (const r of reqs) { try { r.destroy() } catch {} }
  await new Promise((r) => setTimeout(r, 200))
}

function fireOne(target, fixed) {
  const url = new URL(target)
  const up = http.request(
    {
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    },
    (r) => {
      r.on('data', () => {})
      r.on('end', () => {})
    },
  )
  up.on('error', () => {})
  if (fixed) {
    // 修复点：上游空闲（无数据）超过阈值直接销毁，回收 socket
    up.setTimeout(700, () => up.destroy())
  }
  up.write(JSON.stringify({ model: 'test', messages: [], stream: true }))
  up.end()
  return up
}

main().catch((e) => { console.error(e); process.exit(1) })
