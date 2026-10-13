// 临时探针 v2：从新包 D:\DeepSeekAgent 启动 dsh web，认证后拉取 llm.providers / llm.models，
// 验证默认模型列表仅为 deepseek-harness 原生（无 aliyun/qwen/dashscope 默认 provider）。
import { spawn } from 'node:child_process';
import http from 'node:http';

const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const DS_BIN = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const PORT = 5301;
const DSH_HOME = 'C:/Users/Administrator/.dsh';

const env = { ...process.env };
delete env.NODE_OPTIONS;
env.ELECTRON_RUN_AS_NODE = '1';
env.DSH_HOME = DSH_HOME;
env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';

const child = spawn(EXE, ['--expose-internals', DS_BIN, 'web', '--port', String(PORT), '--no-open'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] });

let token = null;
child.stdout.on('data', (d) => {
  const m = d.toString().match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+)/);
  if (m && !token) token = m[1];
});
child.stderr.on('data', () => {});

function rawRequest(opts, body) {
  return new Promise((resolve) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.setTimeout(5000, () => req.destroy());
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const start = Date.now();
  while (!token && Date.now() - start < 25000) await new Promise((r) => setTimeout(r, 300));
  if (!token) { console.log('TOKEN NOT CAPTURED'); try { child.kill('SIGKILL'); } catch {} process.exit(1); }
  console.log('TOKEN captured:', token.slice(0, 8) + '...');

  // 1) 用 token 拿认证 cookie（GET /?token= 会 set-cookie 并 303 到 /）
  const r1 = await rawRequest({ host: '127.0.0.1', port: PORT, path: `/?token=${token}`, method: 'GET' });
  let cookie = (r1.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  console.log('AUTH cookie set:', cookie ? 'yes' : 'NO', '| redirect:', r1.status);
  // 跟随 303 到 /
  if (r1.status === 303 && r1.headers.location) {
    const loc = r1.headers.location.startsWith('http') ? r1.headers.location : `http://127.0.0.1:${PORT}${r1.headers.location}`;
    const u = new URL(loc);
    await rawRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Cookie: cookie } });
  }

  // 2) POST /api/llm.providers 与 /api/llm.models
  const envelope = (method, params = {}) => JSON.stringify({ type: 'server-request', rpcId: 1, method, params });
  const h = { 'Content-Type': 'application/json', Cookie: cookie };
  for (const method of ['llm.providers', 'llm.models']) {
    const r = await rawRequest(
      { host: '127.0.0.1', port: PORT, path: `/api/${method}`, method: 'POST', headers: h },
      envelope(method));
    console.log(`\n=== ${method} -> status ${r.status}, ${r.body.length} bytes`);
    let json; try { json = JSON.parse(r.body); } catch { json = null; }
    if (json) {
      const txt = JSON.stringify(json);
      console.log('   has deepseek:', /deepseek/i.test(txt), '| qwen:', /qwen/i.test(txt),
        '| dashscope/aliyun:', /dashscope|aliyun/i.test(txt), '| glm:', /glm/i.test(txt));
      // 抽取 provider / model 标识
      const ids = [...txt.matchAll(/"?(?:id|name|provider|model)"?\s*:\s*"([\w.-]+(?:deepseek|qwen|glm|aliyun|dashscope)[\w.-]*)"/gi)]
        .map((m) => m[1]);
      if (ids.length) console.log('   matched ids:', [...new Set(ids)].slice(0, 40));
      else {
        // 打印顶层结构，便于人工判断
        const prov = json?.result?.ok ? json.result : json;
        const list = prov?.providers || prov?.data?.providers || prov?.models || prov?.data?.models;
        if (Array.isArray(list)) console.log('   list len:', list.length, '| sample:', JSON.stringify(list.slice(0, 6)).slice(0, 600));
        else console.log('   raw(600):', txt.slice(0, 600));
      }
    } else {
      console.log('   non-JSON body:', r.body.slice(0, 300));
    }
  }

  console.log('\nPROBE DONE');
  try { child.kill('SIGKILL'); } catch {}
  process.exit(0);
})();

setTimeout(() => { console.log('HARD TIMEOUT'); try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 40000);
