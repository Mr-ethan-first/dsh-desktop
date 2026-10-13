'use strict';
/**
 * Plugin registry: discover plugin packages under a directory, track
 * enable/disable state with durable persistence, and answer list/enable
 * queries. State lives in a small JSON file so the renderer and main process
 * agree across restarts.
 *
 * @module apps/agent-client/electron/plugin-host/registry
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseManifest } from './manifest.js';

/**
 * @typedef {ReturnType<typeof parseManifest> & { dir: string, enabled: boolean }} DiscoveredPlugin
 */

class PluginRegistry {
  /**
   * @param {string} pluginsDir - directory holding one subfolder per plugin.
   * @param {string} [stateFile] - override path for the persisted state JSON.
   */
  constructor(pluginsDir, stateFile) {
    /** @type {string} */
    this.pluginsDir = pluginsDir;
    /** @type {string} */
    this.stateFile = stateFile || path.join(pluginsDir, '.plugin-state.json');
    /** @type {{ enabled: Record<string, boolean> }} */
    this._state = this._loadState();
  }

  /** @returns {{ enabled: Record<string, boolean> }} */
  _loadState() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.enabled === 'object') return parsed;
    } catch {
      /* no state yet — start clean */
    }
    return { enabled: {} };
  }

  _saveState() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this._state, null, 2));
  }

  /**
   * Scan the plugins directory and return every recognized plugin.
   * @returns {DiscoveredPlugin[]}
   */
  discover() {
    /** @type {fs.Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    /** @type {DiscoveredPlugin[]} */
    const plugins = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = path.join(this.pluginsDir, entry.name, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      /** @type {Record<string, unknown>} */
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      } catch {
        continue;
      }
      const manifest = parseManifest(pkg);
      if (manifest === null) continue;
      /** @type {DiscoveredPlugin} */
      const discovered = /** @type {DiscoveredPlugin} */ (manifest);
      discovered.dir = path.join(this.pluginsDir, entry.name);
      // Default on unless explicitly disabled in persisted state.
      discovered.enabled = this._state.enabled[manifest.name] !== false;
      plugins.push(discovered);
    }
    return plugins;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  isEnabled(name) {
    const found = this.discover().find(p => p.name === name);
    return found ? found.enabled : false;
  }

  /**
   * @param {string} name
   * @param {boolean} value
   * @returns {boolean} the stored value
   */
  setEnabled(name, value) {
    this._state.enabled[name] = Boolean(value);
    this._saveState();
    return this._state.enabled[name];
  }

  /**
   * @returns {DiscoveredPlugin[]} only the enabled plugins.
   */
  enabledList() {
    return this.discover().filter(p => p.enabled);
  }

  /**
   * @returns {DiscoveredPlugin[]}
   */
  list() {
    return this.discover();
  }
}

export { PluginRegistry };
