/**
 * 内嵌 Cordis 宿主 · 单元测试
 *
 * 验证「选项 B：客户端内嵌 Cordis 运行时」真正生效：
 * - DSH 社区插件（apply(ctx)）被真实执行（能调用桥接服务、能写 ctx 服务）
 * - apply 抛错被优雅捕获写入 error，不崩溃
 * - 缺 entry / 缺服务时有可读错误
 * - deactivate 释放 ctx
 *
 * 用本地 fixture 插件（electron/__fixtures__/*），不依赖网络或完整 DSH host。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCordisHost } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '__fixtures__');

describe('cordis-host：内嵌 Cordis 真正执行 DSH 插件', () => {
  it('sample 插件被激活并调用桥接服务 ctx.toast，且 apply 真的执行', async () => {
    const toasts: Array<{ kind?: string; message: string }> = [];
    const host = createCordisHost({ toast: (p) => toasts.push(p) });

    const rec = await host.activate({
      name: 'sample-dsh-plugin',
      source: 'dsh',
      dir: path.join(fixtures, 'sample-dsh-plugin'),
      entry: 'index.js',
      capabilities: ['demo', 'toast'],
    });

    expect(rec.error).toBeUndefined();
    expect(rec.name).toBe('sample-dsh-plugin');
    expect(host.contexts.has('sample-dsh-plugin')).toBe(true);
    expect(toasts.some((t) => t.kind === 'success' && t.message.includes('已激活'))).toBe(true);
    // 桥接服务之外，插件自己 ctx.set 的服务也能被读到 → 证明 apply(ctx) 真正跑过
    const ctx = host.contexts.get('sample-dsh-plugin').ctx;
    expect(ctx.sampleValue).toBe(42);
  });

  it('apply 抛错的插件被优雅捕获，写入 error 而非崩溃', async () => {
    const host = createCordisHost();
    const rec = await host.activate({
      name: 'broken-dsh-plugin',
      source: 'dsh',
      dir: path.join(fixtures, 'broken-dsh-plugin'),
      entry: 'index.js',
      capabilities: ['broken'],
    });
    expect(rec.error).toBeDefined();
    expect(rec.error).toContain('boom');
    expect(host.contexts.has('broken-dsh-plugin')).toBe(true);
  });

  it('缺少 entry 的插件给出可读错误', async () => {
    const host = createCordisHost();
    const rec = await host.activate({
      name: 'noentry',
      source: 'dsh',
      dir: fixtures,
      entry: '',
      capabilities: [],
    });
    expect(rec.error).toBeDefined();
    expect(rec.error).toContain('entry');
  });

  it('deactivate 释放 ctx', async () => {
    const host = createCordisHost();
    await host.activate({
      name: 'sample-dsh-plugin',
      source: 'dsh',
      dir: path.join(fixtures, 'sample-dsh-plugin'),
      entry: 'index.js',
      capabilities: [],
    });
    expect(host.deactivate('sample-dsh-plugin')).toBe(true);
    expect(host.contexts.has('sample-dsh-plugin')).toBe(false);
  });

  it('重复激活返回同一记录（幂等）', async () => {
    const host = createCordisHost();
    const a = await host.activate({
      name: 'sample-dsh-plugin',
      source: 'dsh',
      dir: path.join(fixtures, 'sample-dsh-plugin'),
      entry: 'index.js',
      capabilities: [],
    });
    const b = await host.activate({
      name: 'sample-dsh-plugin',
      source: 'dsh',
      dir: path.join(fixtures, 'sample-dsh-plugin'),
      entry: 'index.js',
      capabilities: [],
    });
    expect(a).toBe(b);
  });
});
