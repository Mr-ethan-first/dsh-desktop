'use strict';
/**
 * In-app Cordis host for the Electron (DeepSeekAgent) client.
 *
 * Activates community DSH plugins — both `dsh` Cordis bundles and the
 * `deepseek-agent-plugin` native contract (both are Cordis-backed at runtime)
 * — by reusing the project's own `boot()` loader from `@deepseek-ai/dsh-app-boot`.
 * This is integration, not reinvention: the same machinery `dsh web` uses.
 *
 * When the Cordis runtime is linked (after `pnpm install` on the user's
 * machine) activation actually runs the plugin code and the tool/service
 * contributions become available. In a Cordis-free environment (e.g. this
 * sandbox, pre-install) it degrades to a "staged" showcase mode that still
 * parses each plugin's `cordis.patch.yml` and exposes a capability summary,
 * so the client UI can list, present, and toggle community plugins.
 *
 * @module apps/agent-client/electron/plugin-host/cordis-host
 */

import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

/** Lazy-resolve the project Cordis loader; null when not installed. */
let bootModPromise = null;
function loadBoot() {
  if (!bootModPromise) {
    bootModPromise = import('@deepseek-ai/dsh-app-boot')
      .then((m) => (typeof m.boot === 'function' ? m.boot : null))
      .catch(() => null);
  }
  return bootModPromise;
}

/** Find a plugin's Cordis bundle patch file (dsh.bundle.patch), if declared. */
export function findBundlePatch(pluginDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    const bp = pkg?.dsh?.bundle?.patch;
    if (typeof bp === 'string') return path.resolve(pluginDir, bp);
  } catch {
    /* ignore unreadable manifest */
  }
  return null;
}

/**
 * Extract a capability summary from a Cordis patch YAML:
 * inserted plugin names, config keys, and (best-effort) service names.
 * @param {string|null} patchPath
 */
export function summarizePatch(patchPath) {
  const summary = { inserts: [], configKeys: [], services: [] };
  if (!patchPath) return summary;
  try {
    const content = fs.readFileSync(patchPath, 'utf8');
    const docs = yaml.loadAll(content).filter(Boolean);
    for (const doc of docs) {
      if (!Array.isArray(doc)) continue;
      for (const entry of doc) {
        if (!entry || typeof entry !== 'object') continue;
        if (Array.isArray(entry.insert)) {
          for (const ins of entry.insert) {
            if (ins && typeof ins.name === 'string') summary.inserts.push(ins.name);
          }
        }
        if (entry.config && typeof entry.config === 'object') {
          for (const k of Object.keys(entry.config)) summary.configKeys.push(k);
        }
      }
    }
  } catch {
    /* unparsable patch: return the empty summary */
  }
  return summary;
}

/**
 * Create a Cordis host that activates community DSH plugins.
 * @param {object} [opts] bridge services injected into each booted context.
 */
export function createCordisHost(opts = {}) {
  const bridges = opts && typeof opts === 'object' ? opts : {};
  /** @type {Map<string, any>} */
  const activations = new Map();

  /**
   * Activate one discovered plugin.
   * @param {{name:string,dir?:string,capabilities?:string[],source?:string}} plugin
   */
  async function activate(plugin) {
    const name = plugin && plugin.name;
    if (!name) {
      return { name: '', activatedAt: Date.now(), capabilities: [], status: 'error', detail: 'no name' };
    }
    if (activations.has(name)) return activations.get(name);

    const pluginDir = plugin.dir || null;
    const bundlePatch = pluginDir ? findBundlePatch(pluginDir) : null;
    const capabilities = Array.isArray(plugin.capabilities) ? plugin.capabilities : [];
    const summary = summarizePatch(bundlePatch);

    const boot = await loadBoot();
    // Real activation path (requires the Cordis runtime, linked post-install).
    if (boot && bundlePatch) {
      try {
        const ctx = await boot('dsh-host', bundlePatch, [], async (c) => {
          if (bridges.toast) { try { c.provide('toast', bridges.toast); } catch { /* noop */ } }
          if (bridges.fs) { try { c.provide('fs', bridges.fs); } catch { /* noop */ } }
          if (bridges.electron) { try { c.provide('electron', bridges.electron); } catch { /* noop */ } }
        });
        const rec = { name, activatedAt: Date.now(), capabilities, status: 'active', context: ctx, summary };
        activations.set(name, rec);
        return rec;
      } catch (e) {
        const rec = {
          name, activatedAt: Date.now(), capabilities, status: 'error',
          detail: String((e && e.message) || e), summary,
        };
        activations.set(name, rec);
        return rec;
      }
    }

    // Showcase / staged mode: Cordis runtime unavailable (pre-install sandbox).
    const rec = {
      name, activatedAt: Date.now(), capabilities, status: bundlePatch ? 'staged' : 'no-bundle',
      detail: bundlePatch
        ? 'Cordis 运行时未链接（请先 pnpm install）；已解析能力摘要，将在已安装运行时内真正 apply'
        : '插件未声明 dsh.bundle.patch，无法作为 Cordis bundle 激活',
      summary,
    };
    activations.set(name, rec);
    return rec;
  }

  /**
   * Deactivate a plugin (dispose its Cordis context if one was booted).
   * @param {string} name
   */
  function deactivate(name) {
    const rec = activations.get(name);
    if (rec && rec.context && typeof rec.context.fiber?.dispose === 'function') {
      try { rec.context.fiber.dispose(); } catch { /* noop */ }
    }
    return activations.delete(name);
  }

  return { activate, deactivate, contexts: activations, summarizePatch, findBundlePatch };
}
