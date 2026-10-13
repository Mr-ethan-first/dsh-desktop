'use strict';
/**
 * Automated verification for the Electron (DeepSeekAgent) in-app plugin host.
 *
 * Exercises the host core (discovery, manifest recognition, durable
 * enable/disable, activation lifecycle) against the three relocated Phase A
 * plugins. Runs in plain Node (ESM) — no Electron runtime or pnpm install
 * needed — so it is a reliable gate even inside the constrained sandbox.
 *
 * @module scripts/verify-plugin-host
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const HOST_MODULE = path.join(
  ROOT,
  'apps/agent-client/electron/plugin-host/index.js',
);
const REGISTRY_MODULE = path.join(
  ROOT,
  'apps/agent-client/electron/plugin-host/registry.js',
);
const PLUGINS_DIR = path.join(ROOT, 'packages/extensions');
const STATE_FILE = path.join(os.tmpdir(), 'dsh-plugin-host-test-state.json');

const errors = [];
const passed = [];
function check(condition, message) {
  if (condition) passed.push(message);
  else errors.push(message);
}

check(fs.existsSync(HOST_MODULE), 'host module exists: electron/plugin-host/index.js');
if (!fs.existsSync(HOST_MODULE)) report();

const { createPluginHost } = await import(pathToFileURL(HOST_MODULE).href);
const { PluginRegistry } = await import(pathToFileURL(REGISTRY_MODULE).href);

let host;
try {
  host = createPluginHost({ pluginsDir: PLUGINS_DIR, stateFile: STATE_FILE });
  check(true, 'createPluginHost() constructs without Electron runtime');
} catch (error) {
  errors.push(`createPluginHost threw: ${error.message}`);
  report();
}

try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }

const expected = [
  { name: '@deepseek-ai/dsh-modlens', capabilities: ['vision'] },
  { name: '@deepseek-ai/dsh-node-flow', capabilities: ['workflow'] },
  { name: '@deepseek-ai/dsh-market', capabilities: ['market'] },
];

const discovered = host.discover();
const byName = new Map(discovered.map(p => [p.name, p]));

for (const exp of expected) {
  const plugin = byName.get(exp.name);
  check(plugin !== undefined, `discovered: ${exp.name}`);
  if (plugin === undefined) continue;
  check(
    plugin.source === 'deepseek-agent-plugin',
    `${exp.name}: recognized via deepseek-agent-plugin contract (source=${plugin.source})`,
  );
  check(
    JSON.stringify(plugin.capabilities) === JSON.stringify(exp.capabilities),
    `${exp.name}: capabilities = ${JSON.stringify(exp.capabilities)} (got ${JSON.stringify(plugin.capabilities)})`,
  );
  check(typeof plugin.entry === 'string', `${exp.name}: declares an entry module`);
  check(typeof plugin.ui === 'string', `${exp.name}: declares a ui module`);
}

const enabledNames = host.enabledList().map(p => p.name);
check(
  expected.every(e => enabledNames.includes(e.name)),
  'fresh host enables all three plugins by default',
);

host.setEnabled('@deepseek-ai/dsh-market', false);
check(host.isEnabled('@deepseek-ai/dsh-market') === false, 'setEnabled(market, false) takes effect');
check(
  !host.enabledList().some(p => p.name === '@deepseek-ai/dsh-market'),
  'disabled plugin excluded from enabledList()',
);

const reloaded = new PluginRegistry(PLUGINS_DIR, STATE_FILE);
check(
  reloaded.isEnabled('@deepseek-ai/dsh-market') === false,
  'disabled state survives reload (persistence round-trip)',
);

host.setEnabled('@deepseek-ai/dsh-market', true);
check(host.isEnabled('@deepseek-ai/dsh-market') === true, 'setEnabled(market, true) re-enables');

const record = await host.activate(byName.get('@deepseek-ai/dsh-modlens'));
check(
  record && record.name === '@deepseek-ai/dsh-modlens' && Array.isArray(record.capabilities),
  'activate() returns an activation record with capabilities',
);

report();

function report() {
  console.log('\n========= Electron plugin-host automated verification =========');
  for (const message of passed) console.log(`  ✅ ${message}`);
  for (const message of errors) console.log(`  ❌ ${message}`);
  console.log(`\n  ${passed.length} passed, ${errors.length} failed`);
  if (errors.length > 0) {
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: PASS');
  process.exit(0);
}
