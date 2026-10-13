// 可靠部署脚本：将 electron-builder 产出的 win-unpacked 整目录重命名部署到 D:\DeepSeekAgent。
// 设计要点（针对本沙箱 Lenovo/Huorong 杀软锁 + 跨盘安全）：
//   1. 同一卷内 rename 原子且快（D:\ 同盘）。
//   2. moveAside 旧目录时对 EPERM/EACCES/EBUSY 重试（杀软瞬时扫描锁）。
//   3. 部署后做三项硬校验（exe / node24 / dsh bin），任一项缺失即非零退出。
//   4. 全程不依赖后台任务通知；调用方阻塞等待本脚本退出即可拿到结论。
import { renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = 'D:/WorkSpace/deepseek-harness-master/apps/agent-client/release/win-unpacked';
const DST = 'D:/DeepSeekAgent';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function moveAside(target) {
  for (let i = 0; i < 5; i++) {
    const aside = `${target}.removed-${Date.now()}`;
    try {
      renameSync(target, aside);
      console.log('[deploy] moved aside', target, '->', aside);
      return aside;
    } catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        console.error(`[deploy] moveAside attempt ${i} ${e.code}, retry 800ms`);
        sleep(800);
        continue;
      }
      throw e;
    }
  }
  throw new Error('[deploy] moveAside failed after retries (file in use or AV lock)');
}

function renameOrRetry(src, dst) {
  for (let i = 0; i < 8; i++) {
    try {
      renameSync(src, dst);
      console.log('[deploy] deployed', src, '->', dst);
      return;
    } catch (e) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        console.error(`[deploy] rename attempt ${i} ${e.code}, retry 1000ms`);
        sleep(1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('[deploy] rename failed after retries');
}

function main() {
  if (!existsSync(SRC)) {
    console.error('[deploy] SRC missing:', SRC);
    process.exit(2);
  }
  if (existsSync(DST)) {
    moveAside(DST);
  } else {
    console.log('[deploy] DST absent, fresh deploy');
  }
  renameOrRetry(SRC, DST);

  const exe = join(DST, 'DeepSeekAgent.exe');
  const node24 = join(DST, 'resources', 'node24', 'node.exe');
  const dshBin = join(DST, 'resources', 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const okExe = existsSync(exe);
  const okNode = existsSync(node24);
  const okDsh = existsSync(dshBin);
  console.log('[deploy] verify exe   :', okExe);
  console.log('[deploy] verify node24:', okNode);
  console.log('[deploy] verify dsh   :', okDsh);
  if (!okExe || !okNode || !okDsh) {
    console.error('[deploy] VERIFY FAILED');
    process.exit(3);
  }

  // 部署后固化 EXTENSIONS_DIR（#82 防回归）。
  // 关键：win-unpacked 是整目录 rename 部署，会覆盖整个 resources，
  // 而 build 产物并不包含 packages/extensions（社区插件目录）。
  // 若不在此重建「轻量壳目录」，部署态 web profile 只挂 dsh-base + dsh-web-app，
  // 7 个社区插件全部不会被加载（详见 2026-09-02 日志 #82 段）。
  const FIX82 = resolve('scripts/fix-82-extensions.mjs');
  if (existsSync(FIX82)) {
    try {
      console.log('[deploy] building EXTENSIONS_DIR shims (fix-82)...');
      execFileSync(process.execPath, [FIX82], { stdio: 'inherit' });
      console.log('[deploy] EXTENSIONS_DIR shims OK');
    } catch (e) {
      console.error('[deploy] WARNING fix-82 failed:', e && e.message);
      // 不致命：exe 仍可启动（只是社区插件缺失），故不 exit 非零。
    }
  } else {
    console.error('[deploy] WARNING fix-82 script missing:', FIX82);
  }

  console.log('[deploy] DEPLOY OK');
}

main();
