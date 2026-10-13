// 自动化验证：dsh web 端口回退 + 就绪门控算法（镜像 main.cjs 的 startDshWebServer 逻辑）。
// 不依赖 electron / 不拉真实 exe，纯 Node 模拟「端口被占 → 换端口重试 → 真正就绪才上线」。
// 场景：
//   1) 5283 空闲 → 直接绑定 5283 并就绪
//   2) 5283 被别的进程占用 → 旧逻辑会「假在线」（spawn 成功即 return true），
//      新逻辑预检占用 → 拉起失败(子进程退出) → 杀掉 → 换 5284 → 就绪
import net from 'node:net';
import { EventEmitter } from 'node:events';

// 用一个本机确定空闲的基端口，避免与真实占用的 5283 冲突（本机 5283 当前正被某进程占用，
// 这正是用户桥接全断的根因场景）。
function findFreeBase(start) {
  return new Promise((resolve) => {
    const tryOnce = (p) => {
      const s = net.createServer();
      s.once('error', () => { if (p - start < 40) tryOnce(p + 1); else resolve(start); });
      s.once('listening', () => { s.close(() => resolve(p)); });
      s.listen(p, '127.0.0.1');
    };
    tryOnce(start);
  });
}

const PORT = 5183;
let WEB_SERVER_PORT = 0; // 由 findFreeBase 在 main 里赋值
const WEB_PORT_MAX_RETRY = 20;
const DSH_WEB_READY_TIMEOUT_MS = 1500;

let WEB_SERVER_PORT_RESOLVED = WEB_SERVER_PORT;
let workbenchAuthUrl = null;
let workbenchBaseUrl = null;
let dshWebReadyResolve = null;
let dshWebChild = null;

function isPortFree(p) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => { s.close(() => res(true)); });
    s.listen(p, '127.0.0.1');
  });
}
function killDshWebChild() {
  if (dshWebChild) { try { dshWebChild.kill('SIGKILL'); } catch { /* ignore */ } dshWebChild = null; }
}
function waitDshWebReady(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (workbenchAuthUrl) return done(true);
    const onExit = (code) => { if (!workbenchAuthUrl && !settled) done(false); };
    if (dshWebChild) dshWebChild.on('exit', onExit);
    dshWebReadyResolve = () => done(true);
    setTimeout(() => { if (!settled) done(false); }, DSH_WEB_READY_TIMEOUT_MS);
  });
}
function captureDshWebToken(msg) {
  const m = /https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_.-]+/.exec(msg || '');
  if (!m) return;
  workbenchAuthUrl = m[1];
  if (dshWebReadyResolve) { const r = dshWebReadyResolve; dshWebReadyResolve = null; try { r(); } catch { /* ignore */ } }
}

// 假的 dsh web 子进程：behavior='ok' 启动后打印 token；'fail' 立即退出（模拟 EADDRINUSE boot 失败）
function makeFakeChild(port, behavior) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  if (behavior === 'ok') {
    setTimeout(() => captureDshWebToken(`dsh web: http://127.0.0.1:${port}/?token=abc123`), 150);
  } else {
    setTimeout(() => child.emit('exit', 1), 100);
  }
  return child;
}

async function startDshWebServer(spawnLogic) {
  for (let i = 0; i < WEB_PORT_MAX_RETRY; i++) {
    const port = WEB_SERVER_PORT + i;
    WEB_SERVER_PORT_RESOLVED = port;
    if (!(await isPortFree(port))) { console.log(`    precheck ${port} occupied, skip`); continue; }
    dshWebChild = spawnLogic(port);
    if (!dshWebChild) { console.log('    spawn failed'); break; }
    const ok = await waitDshWebReady(port);
    if (ok) { workbenchBaseUrl = `http://127.0.0.1:${port}/`; return { ok: true, port }; }
    killDshWebChild();
  }
  return { ok: false, port: null };
}

let pass = 0, fail = 0;
const assert = (cond, label) => { if (cond) { pass++; console.log('  PASS:', label); } else { fail++; console.log('  FAIL:', label); } };

(async () => {
  WEB_SERVER_PORT = await findFreeBase(6300);
  console.log(`使用本机空闲基端口 WEB_SERVER_PORT=${WEB_SERVER_PORT}`);

  // 场景 1：基端口空闲 → 直接绑定并就绪
  workbenchAuthUrl = null; dshWebChild = null; workbenchBaseUrl = null;
  console.log(`场景 1 (端口 ${WEB_SERVER_PORT} 空闲):`);
  const r1 = await startDshWebServer((port) => makeFakeChild(port, 'ok'));
  console.log('  =>', r1);
  assert(r1.ok && r1.port === WEB_SERVER_PORT, `自由端口直接绑定 ${WEB_SERVER_PORT} 且就绪`);

  // 场景 2：基端口被外部进程占用（复现用户桥接全断的根因场景）→ 回退到 +1
  const blocker = net.createServer();
  await new Promise((res, rej) => { blocker.once('error', rej); blocker.listen(WEB_SERVER_PORT, '127.0.0.1', res); });
  workbenchAuthUrl = null; dshWebChild = null; workbenchBaseUrl = null;
  console.log(`场景 2 (端口 ${WEB_SERVER_PORT} 被占用 → 应回退到 ${WEB_SERVER_PORT + 1}):`);
  const r2 = await startDshWebServer((port) => makeFakeChild(port, port === WEB_SERVER_PORT ? 'fail' : 'ok'));
  console.log('  =>', r2);
  assert(r2.ok && r2.port === WEB_SERVER_PORT + 1, `端口冲突时换到 ${WEB_SERVER_PORT + 1} 并成功就绪（不再假在线）`);
  blocker.close();

  // 场景 3：连续两个端口被占 → 落到 +2
  const b1 = net.createServer(); await new Promise((res, rej) => { b1.once('error', rej); b1.listen(WEB_SERVER_PORT, '127.0.0.1', res); });
  const b2 = net.createServer(); await new Promise((res, rej) => { b2.once('error', rej); b2.listen(WEB_SERVER_PORT + 1, '127.0.0.1', res); });
  workbenchAuthUrl = null; dshWebChild = null; workbenchBaseUrl = null;
  console.log(`场景 3 (${WEB_SERVER_PORT}/${WEB_SERVER_PORT + 1} 均被占 → 应落到 ${WEB_SERVER_PORT + 2}):`);
  const r3 = await startDshWebServer((port) => makeFakeChild(port, port <= WEB_SERVER_PORT + 1 ? 'fail' : 'ok'));
  console.log('  =>', r3);
  assert(r3.ok && r3.port === WEB_SERVER_PORT + 2, `连续冲突时继续递增到 ${WEB_SERVER_PORT + 2}`);
  b1.close(); b2.close();

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
