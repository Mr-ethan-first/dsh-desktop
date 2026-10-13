// 最终验收：通过桌面 DeepSeekAgent.cmd 启动，观察 60s，
// 确认 marker 出现（node 被拉起）且客户端全程存活、无 SIGABRT。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const CMD = 'C:/Users/Administrator/Desktop/DeepSeekAgent.cmd';
const EXE = 'D:/DeepSeekAgent/DeepSeekAgent.exe';
const MARKER = 'D:/DeepSeekAgent/.launched-marker';
const DURATION = 60000;

try { execSync('taskkill /F /IM "DeepSeekAgent.exe" /T', { stdio: 'ignore' }); } catch {}
try { fs.unlinkSync(MARKER); } catch {}

const t0 = Date.now();
console.log('[final-verify] launching', CMD);
const p = spawn('cmd.exe', ['/c', CMD], { cwd: 'D:/DeepSeekAgent', windowsHide: false, detached: true, stdio: 'ignore' });
console.log('[final-verify] cmd pid', p.pid);

let samples = 0, alive = 0, markerSeen = false;
const iv = setInterval(() => {
  samples++;
  try { fs.accessSync(MARKER); markerSeen = true; } catch {}
  let a = false;
  try { a = execSync('tasklist /NH /FI "IMAGENAME eq DeepSeekAgent.exe"', { encoding: 'utf8' }).includes('DeepSeekAgent'); } catch {}
  if (a) alive++;
  if (samples % 4 === 0) console.log(`[t=${((Date.now() - t0) / 1000).toFixed(0)}s] alive=${a}`);
}, 3000);

setTimeout(() => {
  clearInterval(iv);
  try { process.kill(p.pid); } catch {}
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('=== FINAL ===');
  console.log(`marker(node launched) = ${markerSeen}`);
  console.log(`client alive ${alive}/${samples} samples over ${secs}s`);
  const ok = markerSeen && alive >= samples - 1;
  console.log('VERDICT:', ok ? 'PASS - double-click launcher works, client stable' : 'FAIL');
  try { execSync('taskkill /F /IM "DeepSeekAgent.exe" /T', { stdio: 'ignore' }); } catch {}
  process.exit(ok ? 0 : 1);
}, DURATION);
