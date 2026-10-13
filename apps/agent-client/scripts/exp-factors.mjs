// 控制变量实验：区分"ELECTRON_RUN_AS_NODE 变量" vs "父进程=node 信誉" vs "DSH_TEST" 谁是闪退根因
import { spawn, spawnSync } from 'node:child_process';
const EXE = "D:/DeepSeekAgent/DeepSeek 智能体客户端.exe";
const IMAGE = 'DeepSeek 智能体客户端.exe';

function alive() {
  try { const o = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`], { encoding: 'utf8', timeout: 5000 }); return o.stdout.includes(IMAGE); }
  catch { return false; }
}
function killAll() { try { spawnSync('taskkill', ['/IM', IMAGE, '/F'], { encoding: 'utf8', timeout: 8000 }); } catch {} }

function mkEnv(opts) {
  const e = { ...process.env };
  if (opts.clearVar) delete e.ELECTRON_RUN_AS_NODE; else e.ELECTRON_RUN_AS_NODE = '1';
  if (opts.test) e.DSH_TEST = '1'; else delete e.DSH_TEST;
  delete e.DSH_OFFSCREEN;
  return e;
}

async function test(label, env) {
  killAll();
  await new Promise((r) => setTimeout(r, 2000));
  const c = spawn(EXE, [], { env, stdio: 'ignore', detached: true });
  if (c.unref) c.unref();
  const start = Date.now();
  let killedAt = null;
  while (Date.now() - start < 20000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!alive()) { killedAt = Math.round((Date.now() - start) / 1000); break; }
  }
  const ok = alive();
  killAll();
  console.log(`[${label}] -> ${ok ? '存活20s PASS' : '在约' + killedAt + 's消失 FAIL'}  | ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE || '(unset)'}  DSH_TEST=${env.DSH_TEST || '(unset)'}`);
}

(async () => {
  console.log('当前进程 ELECTRON_RUN_AS_NODE =', process.env.ELECTRON_RUN_AS_NODE);
  // A: 与之前 crash-loop 成功案例一致（node 父 + 清变量 + DSH_TEST）
  await test('A node+清变量+DSH_TEST ', mkEnv({ clearVar: true, test: true }));
  // B: node 父 + 清变量 + 无 DSH_TEST（排除 DSH_TEST 是否必要）
  await test('B node+清变量-无DSH_TEST', mkEnv({ clearVar: true, test: false }));
  // C: node 父 + 保留变量 + DSH_TEST（验证变量是否致死）
  await test('C node+变量 +DSH_TEST ', mkEnv({ clearVar: false, test: true }));
})();
