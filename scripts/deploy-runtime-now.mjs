// 可靠部署 dsh-runtime：清理 npm 安装残留的 *_tmp_* 临时目录，再把完整闭包同盘瞬间
// rename 进 D:\DeepSeekAgent\resources\dsh-runtime。绕开 electron-builder 对 688M 大目录
// 的脆弱 copyfile（遇到瞬时临时目录 ENOENT 会整体中止）。全程自校验，调用方阻塞等待即可。
import { renameSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME_SRC = 'D:/WorkSpace/deepseek-harness-master/desktop/runtime-dist';
const DEPLOY_BASE = 'D:/DeepSeekAgent/resources';
const DSH_DST = join(DEPLOY_BASE, 'dsh-runtime');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function rmTmpDirs(root) {
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
  walk(root);
  return removed;
}

function moveAside(target) {
  for (let i = 0; i < 5; i++) {
    const aside = `${target}.broken-${Date.now()}`;
    try { renameSync(target, aside); console.log('[deploy] moved aside', target, '->', aside); return; }
    catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { console.error('[deploy] aside retry', e.code); sleep(800); continue; }
      throw e;
    }
  }
  throw new Error('[deploy] moveAside failed (file in use or AV lock)');
}

function renameOrRetry(src, dst) {
  for (let i = 0; i < 8; i++) {
    try { renameSync(src, dst); console.log('[deploy] rename', src, '->', dst); return; }
    catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) { console.error('[deploy] rename retry', e.code); sleep(1000); continue; }
      throw e;
    }
  }
  throw new Error('[deploy] rename failed after retries');
}

const removed = rmTmpDirs(RUNTIME_SRC);
console.log('[deploy] removed temp dirs:', removed);

const dshBin = join(RUNTIME_SRC, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(dshBin)) { console.error('[deploy] SOURCE missing dsh bin!'); process.exit(2); }
console.log('[deploy] source dsh bin OK');

if (existsSync(DSH_DST)) moveAside(DSH_DST);
renameOrRetry(RUNTIME_SRC, DSH_DST);

const okBin = existsSync(join(DSH_DST, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
const okNode = existsSync(join(DEPLOY_BASE, 'node24', 'node.exe'));
const okExe = existsSync('D:/DeepSeekAgent/DeepSeekAgent.exe');
console.log('[deploy] verify dsh bin:', okBin);
console.log('[deploy] verify node24 :', okNode);
console.log('[deploy] verify exe    :', okExe);
if (!okBin || !okNode || !okExe) { console.error('[deploy] VERIFY FAILED'); process.exit(3); }
console.log('[deploy] DEPLOY OK');
