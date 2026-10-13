'use strict';
/**
 * 在主进程内嵌的 Cordis 运行时，用于真正执行 DSH 社区插件（apply(ctx)）。
 *
 * 背景：DSH 社区插件（dsh-market / dsh-notification / dsh-computer-use …）都是 Cordis 插件，
 * 通过 `apply(ctx)` 注册能力。原先的 plugin-host 只能「发现 + 启用」（activate 只记录元数据），
 * 无法执行其行为。这里用仓库内 vendoring 的 @cordisjs/core（v3）真正跑起来。
 *
 * 桥接策略（只暴露本客户端能够提供的服务，避免过度造轮子）：
 *  - ctx.toast  → 通知中心（经 IPC 推到渲染进程 ToastCenter）
 *  - ctx.fs     → node:fs
 *  - ctx.logger → console
 *  - ctx.electron → 可选的 Electron 能力（shell 等）
 * 依赖完整 DSH host 服务（sessionQuery / toolRegistry / llm / gui …）的插件会因缺少服务而激活
 * 失败；错误被捕获并写入 record.error，由插件市场 UI 展示——这是预期的边界，不是崩溃。
 *
 * @module apps/agent-client/electron/cordis-host
 */
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@cordisjs/core';

/**
 * @param {object} [opts]
 * @param {(payload:{kind?:string,message:string,detail?:string})=>void} [opts.toast]
 * @param {object} [opts.fs]
 * @param {object} [opts.logger]
 * @param {object|null} [opts.electron]
 */
export function createCordisHost(opts = {}) {
  /** @type {Map<string, {name:string, activatedAt:number, capabilities:string[], ctx?:any, error?:string}>} */
  const contexts = new Map();
  const toast = opts.toast || (() => {});
  const fsBridge = opts.fs || fs;
  const logger = opts.logger || console;

  function resolveEntry(plugin) {
    if (!plugin || !plugin.entry) return null;
    const e = plugin.entry;
    if (path.isAbsolute(e)) return e;
    return path.join(plugin.dir || '', e);
  }

  /**
   * 激活一个 DSH 社区插件：动态载入 entry → ctx.plugin → ctx.start（执行 apply(ctx)）。
   * @param {{name:string, source?:string, dir?:string, entry?:string, capabilities?:string[]}} plugin
   */
  async function activate(plugin) {
    if (!plugin || !plugin.name) {
      return { name: '', activatedAt: Date.now(), capabilities: [], error: '缺少插件名' };
    }
    if (contexts.has(plugin.name)) return contexts.get(plugin.name);

    const ctx = new Context();
    // —— 桥接服务（仅暴露本客户端已有能力）——
    ctx.set('toast', {
      push: (msg) => toast(typeof msg === 'string' ? { message: msg } : msg),
      info: (m) => toast({ kind: 'info', message: m }),
      success: (m) => toast({ kind: 'success', message: m }),
      warn: (m) => toast({ kind: 'warn', message: m }),
      error: (m) => toast({ kind: 'error', message: m }),
    });
    ctx.set('fs', fsBridge);
    ctx.set('logger', logger);
    ctx.set('electron', opts.electron || null);

    const entryPath = resolveEntry(plugin);
    let mod;
    try {
      if (!entryPath) throw new Error('插件未声明 entry（dsh.entry 缺失）');
      mod = await import(pathToFileURL(entryPath).href);
    } catch (e) {
      const rec = {
        name: plugin.name,
        activatedAt: Date.now(),
        capabilities: plugin.capabilities || [],
        error: `入口载入失败: ${e && e.message}`,
      };
      contexts.set(plugin.name, rec);
      return rec;
    }

    const pluginObj = mod.default || mod;
    // Cordis 会在内部吞掉 apply 的同步抛错（仅记录），不会向上抛。
    // 因此这里外包一层 apply，自己捕获错误，确保失败能被记录进 record.error
    // 而不是被 Cordis 静默吞掉，同时也保证主进程不会崩溃。
    let capturedErr = null;
    const wrapped =
      typeof pluginObj === 'function'
        ? (c) => {
            try {
              return pluginObj(c);
            } catch (e) {
              capturedErr = e;
            }
          }
        : {
            ...pluginObj,
            apply(c) {
              try {
                return pluginObj.apply(c);
              } catch (e) {
                capturedErr = e;
              }
            },
          };
    try {
      ctx.plugin(wrapped);
      await ctx.start();
    } catch (e) {
      capturedErr = capturedErr || e;
    }
    if (capturedErr) {
      const rec = {
        name: plugin.name,
        activatedAt: Date.now(),
        capabilities: plugin.capabilities || [],
        error: `apply 执行失败: ${capturedErr && capturedErr.message}`,
      };
      contexts.set(plugin.name, rec);
      return rec;
    }

    const rec = {
      name: plugin.name,
      activatedAt: Date.now(),
      capabilities: plugin.capabilities || [],
      ctx,
    };
    contexts.set(plugin.name, rec);
    return rec;
  }

  /** 停用插件（释放其 Cordis ctx）。 */
  function deactivate(name) {
    const rec = contexts.get(name);
    if (!rec) return false;
    try {
      rec.ctx && typeof rec.ctx.stop === 'function' && rec.ctx.stop();
    } catch {
      /* 忽略停用异常 */
    }
    contexts.delete(name);
    return true;
  }

  return { activate, deactivate, contexts, Context };
}
