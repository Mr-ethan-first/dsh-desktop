'use strict';
/**
 * Regression test: prepareDshHome must NOT clobber marketplace-installed
 * bundles on restart.
 *
 * Bug: every startup prepareDshHome rebuilt `$DSH_HOME/profiles/web/package.json`
 * from `readCommunityPlugins(extensionsDir)` only (the vendored packages/extensions
 * tree). dsh-market installs community plugins into the profile's own node_modules
 * and records them in `dsh.profile.bundles` / `dependencies`. Because prepareDshHome
 * overwrote those lists, marketplace-installed plugins were dropped from the bundle
 * stack on the next launch — the package files survived on disk but were never
 * loaded, so the plugin "disappeared after restart".
 *
 * Fix: merge the existing manifest's bundles/dependencies, preserving any entry
 * that is neither an in-box base bundle nor a vendored community plugin (i.e. a
 * marketplace-installed plugin).
 *
 * Pure Node, no Electron. Run: node prepare-dsh-home.test.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareDshHome, readCommunityPlugins } = require('./dsh-web-launcher.cjs');

let failures = 0;
const tmpDirs = [];
function assert(cond, msg) {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    failures++;
    console.error('  ✗ ' + msg);
  }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-test-'));
  tmpDirs.push(d);
  return d;
}

function cleanup() {
  for (const d of tmpDirs) {
    try {
      // 先剥离 profile node_modules 下的 junction（vendored 软链），否则 fs.rm 递归穿透
      // 会被实时扫描拖死（见项目记忆：大目录/含 junction 的递归删除在杀软下极慢或卡死）。
      const nm = path.join(d, 'profiles', 'web', 'node_modules');
      if (fs.existsSync(nm)) {
        for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
          const p = path.join(nm, e.name);
          try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch { /* ignore */ }
  }
}

function readManifest(dshHome, profileName = 'web') {
  return JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'));
}

// ---- Case 1: marketplace bundle must survive a restart with no vendored plugins ----
(function case1() {
  console.log('Case 1: marketplace plugin preserved when extensionsDir yields no vendored plugins');
  const dshHome = tmpDir();
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  // Simulate a prior session where dsh-market installed a community plugin.
  const pre = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'market-plugin-x': '^1.2.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'market-plugin-x'], patchReload: 'live' } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pre, null, 2) + '\n');

  const extensionsDir = tmpDir(); // empty -> readCommunityPlugins returns []
  prepareDshHome({ extensionsDir, dshHome });

  const m = readManifest(dshHome);
  assert(Array.isArray(m.dsh.profile.bundles), 'bundles is an array');
  assert(m.dsh.profile.bundles.includes('market-plugin-x'), 'marketplace bundle market-plugin-x preserved in bundles');
  assert(m.dsh.profile.bundles[0] === '@deepseek-ai/dsh-base', 'base bundle still first');
  assert(m.dependencies['market-plugin-x'] === '^1.2.3', 'marketplace dependency spec preserved');
})();

// ---- Case 2: marketplace bundle must survive alongside vendored plugins ----
(function case2() {
  console.log('Case 2: marketplace + vendored plugins both present after restart');
  const dshHome = tmpDir();
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const pre = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'market-plugin-y': '^0.9.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'market-plugin-y'], patchReload: 'live' } },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pre, null, 2) + '\n');

  const extensionsDir = tmpDir();
  // vendored community plugin with a valid dsh.bundle manifest
  const vp = path.join(extensionsDir, 'dsh-modlens');
  fs.mkdirSync(vp, { recursive: true });
  fs.writeFileSync(path.join(vp, 'package.json'), JSON.stringify({
    name: 'dsh-modlens', version: '1.0.0', dsh: { bundle: { id: 'modlens' } },
  }, null, 2));

  prepareDshHome({ extensionsDir, dshHome });

  const m = readManifest(dshHome);
  assert(m.dsh.profile.bundles.includes('dsh-modlens'), 'vendored bundle dsh-modlens present');
  assert(m.dsh.profile.bundles.includes('market-plugin-y'), 'marketplace bundle market-plugin-y preserved');
  assert(m.dependencies['market-plugin-y'] === '^0.9.0', 'marketplace dependency spec preserved alongside vendored');
  // vendored plugins should remain resolvable via readCommunityPlugins-equivalent scan
  const scanned = readCommunityPlugins(extensionsDir).map(p => p.name);
  assert(scanned.includes('dsh-modlens'), 'vendored plugin still discoverable');
})();

// ---- Case 3: fresh profile (no prior manifest) still initializes cleanly ----
(function case3() {
  console.log('Case 3: fresh profile initializes with base + vendored only');
  const dshHome = tmpDir();
  const extensionsDir = tmpDir();
  const vp = path.join(extensionsDir, 'dsh-node-flow');
  fs.mkdirSync(vp, { recursive: true });
  fs.writeFileSync(path.join(vp, 'package.json'), JSON.stringify({
    name: 'dsh-node-flow', version: '1.0.0', dsh: { bundle: { id: 'node-flow' } },
  }, null, 2));

  prepareDshHome({ extensionsDir, dshHome });

  const m = readManifest(dshHome);
  assert(m.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), 'base bundle present on fresh init');
  assert(m.dsh.profile.bundles.includes('dsh-node-flow'), 'vendored bundle present on fresh init');
  assert(!m.dsh.profile.bundles.some(b => /^(market-plugin|@market)/.test(b)), 'no spurious marketplace bundle on fresh init');
})();

// ---- Case 4: idempotency — re-running does not drop the marketplace bundle ----
(function case4() {
  console.log('Case 4: re-running prepareDshHome keeps marketplace bundle (idempotent)');
  const dshHome = tmpDir();
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'market-plugin-z': '^2.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'market-plugin-z'], patchReload: 'live' } },
  }, null, 2) + '\n');
  const extensionsDir = tmpDir();

  prepareDshHome({ extensionsDir, dshHome });
  // simulate another restart
  prepareDshHome({ extensionsDir, dshHome });

  const m = readManifest(dshHome);
  assert(m.dsh.profile.bundles.includes('market-plugin-z'), 'marketplace bundle survives multiple prepareDshHome runs');
  assert(m.dependencies['market-plugin-z'] === '^2.0.0', 'marketplace dependency spec survives multiple runs');
})();

// ---- Case 5: known-incompatible plugin is stripped from bundles AND dependencies ----
(function case5() {
  console.log('Case 5: blocked plugin @linxin666/dsh-remote-web-ui is stripped (bundles + dependencies)');
  const dshHome = tmpDir();
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  // Simulate a marketplace install of the known-incompatible plugin alongside a good one.
  const pre = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@linxin666/dsh-remote-web-ui': '^0.3.22', 'dsh-pocket': '^2.10.6' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@linxin666/dsh-remote-web-ui', 'dsh-pocket'],
        patchReload: 'live',
      },
    },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pre, null, 2) + '\n');

  // Even if it somehow shows up as a vendored plugin, the real package name must still be dropped.
  const extensionsDir = tmpDir();
  const sneaky = path.join(extensionsDir, 'some-dir-name');
  fs.mkdirSync(sneaky, { recursive: true });
  fs.writeFileSync(path.join(sneaky, 'package.json'), JSON.stringify({
    name: '@linxin666/dsh-remote-web-ui', version: '0.3.22', dsh: { bundle: { id: 'remote-web-ui' } },
  }, null, 2));

  prepareDshHome({ extensionsDir, dshHome });

  const m = readManifest(dshHome);
  assert(!m.dsh.profile.bundles.includes('@linxin666/dsh-remote-web-ui'), 'blocked plugin removed from bundles');
  assert(!Object.prototype.hasOwnProperty.call(m.dependencies, '@linxin666/dsh-remote-web-ui'), 'blocked plugin removed from dependencies');
  assert(m.dsh.profile.bundles.includes('dsh-pocket'), 'good plugin dsh-pocket still present');
  assert(m.dependencies['dsh-pocket'] === '^2.10.6', 'good dependency spec preserved');
  // 黑名单只作用于 prepareDshHome 的落盘结果，不改写 readCommunityPlugins 的原始扫描能力。
  const scanned = readCommunityPlugins(extensionsDir).map((p) => p.name);
  assert(scanned.includes('@linxin666/dsh-remote-web-ui'), 'readCommunityPlugins still lists it (blocking is prepareDshHome-scoped)');
})();

console.log('');
if (failures === 0) {
  console.log('ALL TESTS PASSED');
  cleanup();
  process.exit(0);
} else {
  console.error(failures + ' TEST(S) FAILED');
  cleanup();
  process.exit(1);
}
