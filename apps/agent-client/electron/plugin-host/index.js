'use strict';
/**
 * In-app plugin host for the Electron (DeepSeekAgent) client.
 *
 * Wires discovery + durable enable/disable (PluginRegistry) and exposes an
 * activation lifecycle. Real activation loads a plugin's `entry` module and
 * mounts its `ui` in the renderer; that part is stubbed here because the
 * sandbox cannot build or launch the Electron runtime. The host API is the
 * contract the renderer UI and the (future) IPC bridge call.
 *
 * @module apps/agent-client/electron/plugin-host/index
 */

import { PluginRegistry } from './registry.js';

/**
 * @typedef {Object} PluginHostOptions
 * @property {string} pluginsDir
 * @property {string} [stateFile]
 */

/**
 * Create a plugin host.
 * @param {PluginHostOptions} opts
 * @returns {{
 *   registry: PluginRegistry,
 *   discover: () => ReturnType<PluginRegistry['discover']>,
 *   list: () => ReturnType<PluginRegistry['list']>,
 *   isEnabled: (name: string) => boolean,
 *   setEnabled: (name: string, value: boolean) => boolean,
 *   enabledList: () => ReturnType<PluginRegistry['enabledList']>,
 *   activate: (plugin: object) => Promise<{name:string,activatedAt:number,capabilities:string[],status:string,summary:object|null,error?:string}>,
 *   deactivate: (name: string) => boolean,
 * }}
 */
function createPluginHost(opts) {
  if (!opts || typeof opts.pluginsDir !== 'string') {
    throw new Error('createPluginHost requires { pluginsDir: string }');
  }
  const registry = new PluginRegistry(opts.pluginsDir, opts.stateFile);
  /** @type {Map<string, {name:string,activatedAt:number,capabilities:string[],error?:string}>} */
  const activations = new Map();
  // 缓存的内嵌 Cordis 宿主（按需懒加载，避免 cordis 不可用时拖垮整个宿主）。
  /** @type {any} */
  let cordisHost = null;
  const cordisOpts = opts.cordis && typeof opts.cordis === 'object' ? opts.cordis : {};

  return {
    registry,
    discover: () => registry.discover(),
    list: () => registry.list(),
    isEnabled: name => registry.isEnabled(name),
    setEnabled: (name, value) => registry.setEnabled(name, value),
    enabledList: () => registry.enabledList(),
    /**
     * 激活一个已发现的插件。
     * - `dsh` 源（DSH 社区 Cordis 插件）与 `deepseek-agent-plugin` 源（原生插件契约）：
     *   二者运行期都由 Cordis 驱动（原生 entry 就是 bundle 里 insert 的插件），因此都走
     *   内嵌 Cordis 宿主（cordis-host/index.js）真正 apply(ctx)；桥接服务（toast/fs/logger/electron）
     *   由主进程在创建宿主时注入。Cordis 运行时未链接时降级为 `staged`（解析能力摘要供展示）。
     *   失败仅写入 error/status，不抛。
     * - 其他源（未来纯原生、无 Cordis bundle 的插件）：仅记录元数据。
     * @param {{name:string,source?:string,dir?:string,entry?:string,capabilities?:string[]}} plugin
     */
    async activate(plugin) {
      if (activations.has(plugin.name)) return activations.get(plugin.name);
      if (plugin.source === 'dsh' || plugin.source === 'deepseek-agent-plugin') {
        try {
          if (!cordisHost) {
            const mod = await import('./cordis-host/index.js');
            cordisHost = mod.createCordisHost(cordisOpts);
          }
          const rec = await cordisHost.activate(plugin);
          const record = {
            name: plugin.name,
            activatedAt: rec.activatedAt,
            capabilities: rec.capabilities || (Array.isArray(plugin.capabilities) ? plugin.capabilities : []),
            status: rec.status || 'staged',
            summary: rec.summary || null,
            error: rec.error || null,
          };
          activations.set(plugin.name, record);
          return record;
        } catch (e) {
          const record = {
            name: plugin.name,
            activatedAt: Date.now(),
            capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
            status: 'error',
            summary: null,
            error: `Cordis 宿主不可用: ${e && e.message}`,
          };
          activations.set(plugin.name, record);
          return record;
        }
      }
      // 其他源：仅记录元数据。
      const record = {
        name: plugin.name,
        activatedAt: Date.now(),
        capabilities: Array.isArray(plugin.capabilities) ? plugin.capabilities : [],
        status: 'metadata-only',
      };
      activations.set(plugin.name, record);
      return record;
    },
    deactivate: (name) => {
      if (cordisHost && cordisHost.contexts.has(name)) cordisHost.deactivate(name);
      return activations.delete(name);
    },
  };
}

export { createPluginHost, PluginRegistry };
