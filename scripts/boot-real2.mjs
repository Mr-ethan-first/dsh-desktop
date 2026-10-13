// Use the REAL boot() from dsh-app-boot (same as `dsh web`), with the exact
// prepare(hostCtx) callback runProfile uses. Race against a timeout; on hang or
// throw, dump the pending/failed cordis entry that breaks the bridge.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const require = createRequire('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const RG = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';

async function imp(spec) {
  const p = require.resolve(spec);
  return import(pathToFileURL(p).href);
}
const { Context } = await imp('@deepseek-ai/cordis');
const { loadProfile, mountRootInclude, loadOptionalPatches, boot } = require(RG + '/dsh-app-boot');
const { resolveDshHome } = require(RG + '/dsh-home-paths');
const { provideCmdline } = require(RG + '/dsh-cmdline');
const DSH_LAUNCH_ENVIRONMENT_KEY = 'dsh.launch.environment';

const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
process.env.DSH_HOME = DSH_HOME;
const PORT = 5283;

const INSTALL_ANCHOR = RG + '/dsh/package.json';
const NAME = 'dsh';
const profile = loadProfile(NAME, 'web', INSTALL_ANCHOR, DSH_HOME, { userLayer: true });
const rootConfig = path.join(profile.dir, 'cordis.yml');

const homePatchPath = path.join(DSH_HOME, 'cordis.patch.yml');
const patches = [
  ...(profile.layers ? profile.layers.flatMap((l) => l.patches || []) : []),
  ...(profile.patches || []),
  ...(loadOptionalPatches(NAME, homePatchPath) || []),
];

const prepare = (hostCtx) => {
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, { appName: 'dsh', profile: 'web', args: [] });
  provideCmdline(hostCtx, {
    args: ['--port', String(PORT)],
    exit: () => {},
    ready: { onReady() {} }
  });
};

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('BOOT_HANG_TIMEOUT')), 30000));

try {
  const ctx = await Promise.race([ boot(NAME, rootConfig, structuredClone(patches), prepare, undefined), timeout ]);
  console.log('BOOT RESOLVED (ctx present=' + (!!ctx) + ')');
  const loader = ctx && ctx.get('loader');
  if (loader) {
    let active = 0, pending = 0, failed = 0;
    for (const e of loader.entries()) {
      const st = e.fiber ? e.fiber.state : 'nofiber';
      const missing = e.fiber && e.fiber.inject ? Object.keys(e.fiber.inject).filter((s) => ctx.get(s) === undefined) : [];
      if (st === 2) active++; else if (st === 0) pending++; else if (st === 3) failed++;
      if (st !== 2) console.log(`[${String(st)}] ${e.options && e.options.name} missing=${missing.join(',')}`);
    }
    console.log(`SUMMARY active=${active} pending=${pending} failed=${failed}`);
  }
  process.exit(0);
} catch (e) {
  console.log('BOOT ERROR / HANG: ' + (e && e.message));
  if (e && e.message === 'BOOT_HANG_TIMEOUT') {
    console.log('(hung — loader never settled; pending entry above if any)');
  } else {
    console.log((e && e.stack || '').split('\n').slice(0, 8).join('\n'));
  }
  process.exit(0);
}
