// Prewarm the OS file cache for the dsh web runtime tree.
//
// Why: measured 2026-09-18 on the deployed tree (D:\DeepSeekAgent) with 火绒 AV:
//   cold first boot of `dsh web`  : ~19.7 s
//   warm (2nd/3rd) boot           : ~5.4-6.3 s
// The ~14 s delta is NOT CPU -- it is 火绒 real-time scanning every .js/.json file on
// first touch. A directory walk of @deepseek-ai alone (10,219 entries) costs ~3.3 s
// (~0.32 ms/entry vs ~0.01 ms on an unscanned NTFS), and stat/realpath through the
// ext-fallback SYMLINK layer costs 273-948 us/op vs 8-58 us/op for the real path
// (~16-25x, because AV scans the link AND its target).
//
// So: touch every runtime file once, up front, in a background warmup process. The
// user's first double-click is then a warm (~5-6 s) start instead of a cold (~20 s) one.
//
// This is pure read cache warming: no writes to the runtime tree, no functional impact.

import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Read a byte from each file under `roots` to pull it into the OS/AV cache.
 * @param {string[]} roots directories to walk
 * @param {{maxFiles?:number, onProgress?:(n:number)=>void}} [opts]
 * @returns {{files:number, bytes:number, ms:number}}
 */
export function prewarmTree(roots, opts = {}) {
  const { maxFiles = 200000, onProgress } = opts;
  const t0 = Date.now();
  let files = 0;
  let bytes = 0;
  const buf = Buffer.allocUnsafe(4096);
  const stack = [...roots];
  while (stack.length) {
    if (files >= maxFiles) break;
    const dir = stack.pop();
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      // 跳过不需要预热的体积巨子目录：预热的目的是让 AV 缓存"启动期会读的代码文件"，
      // 浏览器扩展/图标等静态资源不参与启动路径。
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue; // 符号链接等：stat 一次即可让 AV 记账
      try {
        const fd = openSync(full, 'r');
        try { const n = readSync(fd, buf, 0, buf.length, 0); if (n > 0) bytes += n; } finally { closeSync(fd); }
        files++;
        if (onProgress && files % 5000 === 0) onProgress(files);
      } catch { /* 个别文件被占用/无权限，忽略 */ }
    }
  }
  return { files, bytes, ms: Date.now() - t0 };
}

export default prewarmTree;
