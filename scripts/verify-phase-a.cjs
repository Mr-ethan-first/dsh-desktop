'use strict';
/**
 * Phase A automated verification gate.
 *
 * Covers the two things that must be true before the plugin-integration
 * milestone can be called "done enough to verify":
 *
 *   1. The EMFILE root cause (socket leak that broke multi-turn chat /
 *      auto-generate-code) is fixed in the real Electron client code
 *      (main.cjs handleProxy + harness llm.js DeepSeekAdapter.stream), and
 *      the leak-vs-fix mechanism is reproducible (repro-emfile.cjs).
 *   2. The three Phase A plugins are correctly wired as cordis bundles:
 *      renamed to @deepseek-ai/dsh-*, peerDependency on @deepseek-ai/cordis,
 *      their dsh.bundle.patch file exists and parses, and each patch's
 *      insert.name matches the package name — and the plugins profile
 *      template registers all three.
 *
 * Exit code is non-zero on the first failing assertion group so CI stops.
 *
 * @module scripts/verify-phase-a
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const passed = [];

function check(condition, message) {
  if (condition) passed.push(message);
  else errors.push(message);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. EMFILE fix — static markers in the real client code
// ─────────────────────────────────────────────────────────────────────────
const mainCjs = path.join(ROOT, 'apps/agent-client/electron/main.cjs');
const llmJs = path.join(ROOT, 'apps/agent-client/electron/harness-dist/llm.js');

check(fs.existsSync(mainCjs), 'file exists: electron/main.cjs');
check(fs.existsSync(llmJs), 'file exists: electron/harness-dist/llm.js');

if (fs.existsSync(mainCjs)) {
  const src = fs.readFileSync(mainCjs, 'utf8');
  check(
    /UPSTREAM_CONNECT_TIMEOUT/.test(src)
      && /up\.setTimeout/.test(src)
      && /up\.destroy/.test(src)
      && /settled/.test(src),
    'EMFILE fix in main.cjs: handleProxy guards the upstream socket (timeout + destroy + settled)',
  );
}
if (fs.existsSync(llmJs)) {
  const src = fs.readFileSync(llmJs, 'utf8');
  check(
    /AbortController/.test(src) && /PROVIDER_TIMEOUT/.test(src) && /reader\.cancel/.test(src),
    'EMFILE fix in harness llm.js: DeepSeekAdapter.stream has timeout + AbortController + reader.cancel',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2. EMFILE fix — behavioral reproduction (buggy leaks, fixed recycles)
// ─────────────────────────────────────────────────────────────────────────
let reproOut = '';
try {
  reproOut = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/repro-emfile.cjs')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
  );
} catch (error) {
  errors.push(`repro-emfile.cjs failed to run: ${error.message}`);
}
check(
  /1500ms 后 open socket : 200/.test(reproOut),
  'EMFILE repro: BUGGY branch leaks 200 sockets (root cause reproduced)',
);
check(
  /1600ms 后 open socket : 0/.test(reproOut),
  'EMFILE repro: FIXED branch recycles to 0 open sockets (fix verified)',
);

// ─────────────────────────────────────────────────────────────────────────
// 3. Plugin contract checks (the mechanical Phase A integration)
// ─────────────────────────────────────────────────────────────────────────
const yaml = require(path.join(ROOT, 'node_modules/js-yaml'));

const plugins = [
  { dir: 'packages/extensions/dsh-modlens', name: '@deepseek-ai/dsh-modlens', id: 'modlens' },
  { dir: 'packages/extensions/dsh-node-flow', name: '@deepseek-ai/dsh-node-flow', id: 'dsh-node-flow' },
  { dir: 'packages/extensions/dsh-market', name: '@deepseek-ai/dsh-market', id: 'dsh-market' },
];

const seenInsertNames = new Set();
for (const plugin of plugins) {
  const pkgPath = path.join(ROOT, plugin.dir, 'package.json');
  check(fs.existsSync(pkgPath), `exists: ${plugin.dir}/package.json`);
  if (!fs.existsSync(pkgPath)) continue;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  check(pkg.name === plugin.name, `package name is ${plugin.name} (got ${pkg.name})`);
  check(
    pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string',
    `${plugin.name}: declares dsh.bundle.patch`,
  );

  const peer = pkg.peerDependencies || {};
  check('@deepseek-ai/cordis' in peer, `${plugin.name}: peerDependency on @deepseek-ai/cordis`);

  if (pkg.dsh && pkg.dsh.bundle && typeof pkg.dsh.bundle.patch === 'string') {
    const patchPath = path.join(ROOT, plugin.dir, pkg.dsh.bundle.patch);
    check(fs.existsSync(patchPath), `${plugin.name}: patch file exists at ${pkg.dsh.bundle.patch}`);
    if (fs.existsSync(patchPath)) {
      let doc;
      try {
        doc = yaml.load(fs.readFileSync(patchPath, 'utf8'));
      } catch (error) {
        errors.push(`${plugin.name}: cordis.patch.yml parse error: ${error.message}`);
      }
      if (doc !== undefined) {
        check(Array.isArray(doc), `${plugin.name}: cordis.patch.yml is a YAML array`);
        for (const entry of (doc || [])) {
          if (entry && Array.isArray(entry.insert)) {
            for (const insert of entry.insert) {
              check(
                insert.name === plugin.name,
                `${plugin.name}: patch insert.name === package name (got ${insert.name})`,
              );
              check(
                !seenInsertNames.has(insert.name),
                `${plugin.name}: insert.name unique across plugins`,
              );
              seenInsertNames.add(insert.name);
              check(
                insert.id === plugin.id,
                `${plugin.name}: patch insert.id === ${plugin.id} (got ${insert.id})`,
              );
            }
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. profile.ts registers all three bundles in the `plugins` template
// ─────────────────────────────────────────────────────────────────────────
const profileSrc = fs.readFileSync(
  path.join(ROOT, 'packages/boot/app-boot/src/profile.ts'),
  'utf8',
);
const allRegistered = plugins.every(
  (plugin) => profileSrc.includes(`'${plugin.name}'`) || profileSrc.includes(`"${plugin.name}"`),
);
check(allRegistered, 'profile.ts `plugins` template registers all 3 @deepseek-ai/dsh-* bundles');

// ─────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────
console.log('\n================ Phase A automated verification ================');
for (const message of passed) console.log(`  ✅ ${message}`);
for (const message of errors) console.log(`  ❌ ${message}`);
console.log(`\n  ${passed.length} passed, ${errors.length} failed`);

if (errors.length > 0) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
}
console.log('\nRESULT: PASS');
process.exit(0);
