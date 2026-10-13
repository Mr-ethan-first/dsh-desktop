import { describe, it, expect } from 'vitest';
import path from 'node:path';
// vitest 的 ESM 转换对 .cjs 文件的具名导出探测不稳定，
// 故统一用 default import（= module.exports）再解构，跨环境最稳。
import scanExtModule from '../electron/plugin-host/scan-extensions.cjs';
const { scanLocalExtensions, findBundlePatch, summarizePatch } = scanExtModule as any;

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const EXT_DIR = path.join(repoRoot, 'packages', 'extensions');

describe('scanLocalExtensions (选项一：自己接管扫描)', () => {
  it('扫描 packages/extensions 返回 vendored 社区插件', () => {
    const items = scanLocalExtensions(EXT_DIR);
    expect(items.length).toBeGreaterThanOrEqual(3);
    const names = items.map((i) => i.name);
    for (const n of ['@deepseek-ai/dsh-modlens', '@deepseek-ai/dsh-node-flow', '@deepseek-ai/dsh-market']) {
      expect(names).toContain(n);
    }
  });

  it('vendored 插件声明了 cordis.patch.yml（hasBundlePatch=true）', () => {
    const items = scanLocalExtensions(EXT_DIR);
    for (const it of items) {
      if (it.name.includes('dsh-modlens') || it.name.includes('dsh-node-flow') || it.name.includes('dsh-market')) {
        expect(it.hasBundlePatch).toBe(true);
        expect(Array.isArray(it.summary.inserts)).toBe(true);
      }
    }
  });

  it('findBundlePatch 解析绝对路径', () => {
    const bp = findBundlePatch(path.join(EXT_DIR, 'dsh-modlens'));
    expect(typeof bp).toBe('string');
    expect(bp && bp.endsWith('cordis.patch.yml')).toBe(true);
  });

  it('summarizePatch 对不存在路径返回空摘要', () => {
    const s = summarizePatch(path.join(EXT_DIR, 'does-not-exist', 'cordis.patch.yml'));
    expect(s).toEqual({ inserts: [], configKeys: [], services: [] });
  });

  it('不存在的目录返回空数组', () => {
    expect(scanLocalExtensions(path.join(repoRoot, 'no-such-dir'))).toEqual([]);
  });
});
