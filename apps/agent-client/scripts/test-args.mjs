// 验证：哪些启动参数能避免主进程 0x80000003 原生崩溃（无需重建，直接外部传参给 exe）
import { spawn, spawnSync } from 'node:child_process';
const EXE = "D:/DeepSeekAgent/DeepSeek 智能体客户端.exe";
const IMAGE = 'DeepSeek 智能体客户端.exe';

function alive() {
  try { const o = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`], { encoding: 'utf8', timeout: 5000 }); return o.stdout.includes(IMAGE); }
  catch { return false; }
}
function killAll() { try { spawnSync('taskkill', ['/IM', IMAGE, '/F'], { encoding: 'utf8', timeout: 8000 }); } catch {} }

async function run(label, args, viaExplorer) {
  killAll();
  await new Promise((r) => setTimeout(r, 2000));
  let c;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.DSH_TEST = '1';
  if (viaExplorer) {
    c = spawn('cmd.exe', ['/c', 'start', '', EXE, ...args], { detached: true, stdio: 'ignore', windowsHide: false });
  } else {
    c = spawn(EXE, args, { env, detached: true, stdio: 'ignore' });
  }
  if (c.unref) c.unref();
  const start = Date.now();
  let k = null;
  while (Date.now() - start < 25000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!alive()) { k = Math.round((Date.now() - start) / 1000); break; }
  }
  const ok = alive();
  killAll();
  console.log(`[${label}] -> ${ok ? '存活25s PASS' : '在' + k + 's消失 FAIL'}  viaExplorer=${viaExplorer}  args=${JSON.stringify(args)}`);
}

(async () => {
  console.log('当前 ELECTRON_RUN_AS_NODE =', process.env.ELECTRON_RUN_AS_NODE, '(已在子进程环境清除)');
  const base = ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage'];
  await run('T1 node+noSandbox', base, false);
  await run('T2 explorer+noSandbox', base, true);
  const full = ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-software-rasterizer', '--in-process-gpu', '--disable-features=Vulkan'];
  await run('T3 node+full', full, false);
  const fullExp = ['--no-sandbox', '--no-zygote', '--disable-dev-shm-usage', '--disable-software-rasterizer', '--in-process-gpu', '--disable-features=Vulkan'];
  await run('T4 explorer+full', fullExp, true);
})();
