// 扫描仓库内 vendored 的社区插件目录（packages/extensions），
// 解析每个插件的 package.json 与 cordis.patch.yml，产出可供 UI 展示与「分发加载」的清单。
// 纯 Node 实现，零 Electron 依赖，可被 vitest 直接单测（选项一：自己接管扫描）。
// 注意：本文件必须保持 .cjs 扩展名——apps/agent-client/package.json 为 "type":"module"，
// 同目录下的 .js 会被当作 ESM 处理，若用 module.exports 会被 main.cjs 的 require 触发
// ERR_REQUIRE_ESM；而 electron/ 目录其余文件均为 .cjs，统一 CommonJS 最稳。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

let yaml = null;
try { yaml = require("js-yaml"); } catch { /* 无 js-yaml 时仅做结构扫描，不解析 patch 摘要 */ }

/** 返回插件目录内声明的 cordis.patch.yml 绝对路径（无则 null）。 */
function findBundlePatch(pluginDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
    const bp = pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
    if (typeof bp === "string") return path.resolve(pluginDir, bp);
  } catch { /* ignore */ }
  return null;
}

/** 解析 cordis.patch.yml，提取 inserts / configKeys / services 摘要。 */
function summarizePatch(patchPath) {
  const summary = { inserts: [], configKeys: [], services: [] };
  if (!patchPath || !yaml) return summary;
  try {
    const content = fs.readFileSync(patchPath, "utf8");
    const docs = yaml.loadAll(content).filter(Boolean);
    for (const doc of docs) {
      if (!Array.isArray(doc)) continue;
      for (const entry of doc) {
        if (!entry || typeof entry !== "object") continue;
        if (Array.isArray(entry.insert)) {
          for (const ins of entry.insert) if (ins && typeof ins.name === "string") summary.inserts.push(ins.name);
        }
        if (entry.config && typeof entry.config === "object") {
          for (const k of Object.keys(entry.config)) summary.configKeys.push(k);
        }
        if (Array.isArray(entry.services)) {
          for (const s of entry.services) if (s && typeof s.name === "string") summary.services.push(s.name);
        }
      }
    }
  } catch { /* 解析失败不阻断扫描 */ }
  return summary;
}

/**
 * 扫描扩展目录，返回每个子目录插件的元信息。
 * @param {string} extDir 扩展目录（如 packages/extensions）
 * @returns {Array<{name:string,displayName:string,version:string,dir:string,description:string,hasBundlePatch:boolean,isDshPlugin:boolean,capabilities:string[],summary:object}>}
 */
function scanLocalExtensions(extDir) {
  const out = [];
  if (!extDir || !fs.existsSync(extDir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(extDir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(extDir, ent.name);
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { continue; }
    const bundlePatch = findBundlePatch(dir);
    const isDshPlugin = !!(pkg.dsh || pkg["deepseek-agent-plugin"]);
    out.push({
      name: pkg.name || ent.name,
      displayName: pkg.displayName || pkg.name || ent.name,
      version: pkg.version || "",
      dir,
      description: typeof pkg.description === "string" ? pkg.description : "",
      hasBundlePatch: !!bundlePatch,
      isDshPlugin,
      capabilities: Array.isArray(pkg.capabilities) ? pkg.capabilities : [],
      summary: summarizePatch(bundlePatch),
    });
  }
  return out;
}

module.exports = { scanLocalExtensions, findBundlePatch, summarizePatch };
