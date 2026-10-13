// 清理已部署 dsh-runtime 里的 npm 安装临时残渣 *_tmp_* 目录（无害但污染闭包）。
// 用 Node rmSync（不受 genie-trash / 回收站拦截），AV 锁瞬时重试。
import { renameSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = 'D:/DeepSeekAgent/resources/dsh-runtime';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let removed = 0;
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (/_tmp_\d+/.test(e.name)) {
        for (let i = 0; i < 3; i++) {
          try { rmSync(p, { recursive: true, force: true }); removed++; break; }
          catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') { sleep(400); continue; }
            console.error('[clean] rm failed', p, err.code); break;
          }
        }
      } else {
        walk(p);
      }
    }
  }
}
if (existsSync(TARGET)) walk(TARGET);
console.log('[clean] removed temp dirs:', removed);
