// 运行时验证：启动真实客户端，等待 WorkspaceChip 挂载触发 getRecent
// → 主进程必然 initSqlJs() 加载 asar 内 sql.js。检查日志无 sql.js/wasm/模块错误。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CMD = 'C:/Users/Administrator/Desktop/DeepSeekAgent.cmd';
const DURATION = 18000;

try { execSync('taskkill /F /IM "DeepSeekAgent.exe" /T', { stdio: 'ignore' }); } catch {}
const p = spawn('cmd.exe', ['/c', CMD], { cwd: 'D:/DeepSeekAgent', detached: true, stdio: 'ignore' });
console.log('[sqlite-verify] launched cmd pid', p.pid);

setTimeout(() => {
  const dir = path.join(process.env.LOCALAPPDATA, 'Temp', 'dsh-agent-logs');
  let f = null;
  try {
    const logs = fs.readdirSync(dir)
      .filter((x) => x.startsWith('electron-') && x.endsWith('.log'))
      .map((x) => ({ x, m: fs.statSync(path.join(dir, x)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    f = path.join(dir, logs[0].x);
  } catch (e) { console.log('no log dir:', e.message); }

  let errLines = [];
  if (f) {
    const content = fs.readFileSync(f, 'utf8');
    errLines = content.split('\n').filter((l) =>
      /sql\.js|workspace-history|wasm|Cannot find module|EMFILE|initSqlJs/i.test(l) &&
      /error|fail|throw|cannot|undefined/i.test(l)
    );
  }
  let alive = false;
  try {
    alive = execSync('tasklist /NH /FI "IMAGENAME eq DeepSeekAgent.exe"', { encoding: 'utf8' }).includes('DeepSeekAgent');
  } catch {}

  console.log('=== sqlite runtime verify ===');
  console.log('log file:', f);
  console.log('error lines (sql.js/wasm/module related):', errLines.length);
  errLines.slice(-15).forEach((l) => console.log('   ', l.trim()));
  console.log('client alive:', alive);
  const ok = alive && errLines.length === 0;
  console.log('VERDICT:', ok ? 'PASS - sql.js loads fine in Electron runtime' : 'CHECK NEEDED');
  try { execSync('taskkill /F /IM "DeepSeekAgent.exe" /T', { stdio: 'ignore' }); } catch {}
  process.exit(ok ? 0 : 1);
}, DURATION);
