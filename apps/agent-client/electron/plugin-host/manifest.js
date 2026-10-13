'use strict';
/**
 * Plugin manifest recognition for the Electron (DeepSeekAgent) in-app host.
 *
 * A package is treated as a host plugin when its package.json carries a
 * `deepseek-agent-plugin` section (preferred contract for this client) or a
 * `dsh` section (cordis bundle — accepted as compatible so the same packages
 * also work under the `dsh` launcher). The host never loads the plugin's
 * module here; it only reads metadata to drive discovery, enable/disable, and
 * (later) UI mounting.
 *
 * @module apps/agent-client/electron/plugin-host/manifest
 */

/**
 * @typedef {Object} PluginManifest
 * @property {string} name
 * @property {string} version
 * @property {string} displayName
 * @property {string} description
 * @property {string[]} capabilities
 * @property {string} [entry] Absolute-or-package-relative module entry.
 * @property {string} [ui] Package-relative browser entry (mounted in renderer).
 * @property {'deepseek-agent-plugin'|'dsh'} source
 */

/**
 * Parse a package.json into a host plugin manifest, or null if it is not a plugin.
 * @param {Record<string, unknown>} pkg - parsed package.json.
 * @returns {PluginManifest|null}
 */
function parseManifest(pkg) {
  if (typeof pkg !== 'object' || pkg === null) return null;
  const host = pkg['deepseek-agent-plugin'];
  const dsh = pkg.dsh;
  /** @type {Record<string, unknown>|null} */
  let section = null;
  /** @type {'deepseek-agent-plugin'|'dsh'} */
  let source = 'deepseek-agent-plugin';
  if (host !== undefined && host !== null) {
    section = /** @type {Record<string, unknown>} */ (host);
    source = 'deepseek-agent-plugin';
  } else if (dsh !== undefined && dsh !== null) {
    section = /** @type {Record<string, unknown>} */ (dsh);
    source = 'dsh';
  }
  if (section === null) return null;

  const capabilities = Array.isArray(section.capabilities)
    ? /** @type {unknown[]} */ (section.capabilities).filter(c => typeof c === 'string')
    : [];

  let entry = typeof section.entry === 'string' ? /** @type {string} */ (section.entry) : undefined;
  if (entry === undefined && dsh !== null) {
    // Fall back to the package's main/exports for cordis bundles.
    if (typeof pkg.main === 'string') entry = /** @type {string} */ (pkg.main);
    else if (pkg.exports && typeof pkg.exports === 'object') {
      const dot = /** @type {Record<string, unknown>} */ (pkg.exports)['.'];
      if (dot && typeof dot === 'object') {
        const d = /** @type {Record<string, unknown>} */ (dot);
        entry = typeof d.import === 'string' ? d.import
          : typeof d.default === 'string' ? d.default : undefined;
      }
    }
  }

  const ui = typeof section.ui === 'string' ? /** @type {string} */ (section.ui) : undefined;

  return {
    name: /** @type {string} */ (pkg.name),
    version: typeof pkg.version === 'string' ? pkg.version : '',
    displayName: typeof pkg.displayName === 'string' ? pkg.displayName : /** @type {string} */ (pkg.name),
    description: typeof pkg.description === 'string' ? pkg.description : '',
    capabilities: /** @type {string[]} */ (capabilities),
    entry,
    ui,
    source,
  };
}

export { parseManifest };
