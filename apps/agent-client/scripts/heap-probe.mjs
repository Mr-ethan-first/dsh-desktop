// 快速 CDP 堆采样（Node 内置 WebSocket，无外部依赖）。
// dist 到 <tmp>/dsh-agent-logs，分析主进程 JS 堆在启动后的增长。
import http from 'node:http'

const port = Number(process.argv[2] || 9231)
const durationMs = Number(process.argv[3] || 25000)

function httpGet(path) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (s) => {
      let b = ''
      s.on('data', (d) => (b += d))
      s.on('end', () => res(b))
    })
    r.on('error', rej)
    r.end()
  })
}

async function getWsUrl() {
  const list = JSON.parse(await httpGet('/json/list'))
  const t = list.find((x) => x.type === 'node') || list[0]
  return t.webSocketDebuggerUrl
}

async function main() {
  const url = await getWsUrl()
  // Node 内置 WebSocket（--experimental-websocket）
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  let opened = false

  await new Promise((res, rej) => {
    ws.addEventListener('open', () => { opened = true; res() })
    ws.addEventListener('error', (e) => rej(e))
  })

  ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }
  })

  function rpc(method, params) {
    return new Promise((res, rej) => {
      const mid = String(++id)
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('rpc timeout ' + method)) } }, 5000)
    })
  }

  // 必须先 enable 域，否则 evaluate 无回包
  try { await rpc('Runtime.enable', {}) } catch (e) { console.log('Runtime.enable 失败:', e.message) }

  const t0 = Date.now()
  const samples = []
  while (Date.now() - t0 < durationMs) {
    let res
    try {
      res = await rpc('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true })
    } catch (e) {
      console.log('evaluate 失败:', e.message)
      break
    }
    if (!res || !res.result || !res.result.value) { console.log('无返回值'); break }
    const o = JSON.parse(res.result.value)
    samples.push([Math.round((Date.now() - t0) / 1000), Math.round(o.heapUsed / 1048576), Math.round(o.rss / 1048576), Math.round(o.external / 1048576)])
    const s = samples[samples.length - 1]
    console.log(`t=${s[0]}s heap=${s[1]}MB rss=${s[2]}MB external=${s[3]}MB`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log('RESULT=' + JSON.stringify(samples))
  try { ws.close() } catch { /* ignore */ }
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })