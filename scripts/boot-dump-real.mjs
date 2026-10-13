// Boot-replica against the REAL persistent dsh-home. If the profile patch file
// is missing, write the default `[]` (mirrors initProfile). Then dump every
// cordis entry's fiber state + unsatisfied injects to find the PENDING entry.
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
const Loader = (await imp('@deepseek-ai/cordis-plugin-loader')).default;
const { loadProfile, mountRootInclude, loadOptionalPatches } = require(RG + '/dsh-app-boot');
const { resolveDshHome } = require(RG + '/dsh-home-paths');
const { provideCmdline } = require(RG + '/dsh-cmdline');
const DSH_LAUNCH_ENVIRONMENT_KEY = 'dsh.launch.environment';

const DSH_HOME = 'C:/Users/Administrator/AppData/Roaming/@deepseek-ai/dsh-agent-client/dsh-home';
process.env.DSH_HOME = DSH_HOME;

const INSTALL_ANCHOR = RG + '/dsh/package.json';
const NAME = 'dsh';
let profile;
try {
  profile = loadProfile(NAME, 'web', INSTALL_ANCHOR, DSH_HOME, { userLayer: true });
} catch (e) {
  console.log('loadProfile ERROR: ' + (e && e.stack || e));
  process.exit(1);
}
console.log('resolveDshHome()=' + resolveDshHome());
console.log('profile.dir=' + profile.dir);
console.log('profile.patchPath=' + profile.patchPath + ' exists=' + fs.existsSync(profile.patchPath));
const rootConfig = path.join(profile.dir, 'cordis.yml');
console.log('rootConfig(cordis.yml)=' + rootConfig + ' exists=' + fs.existsSync(rootConfig));

const ctx = new Context();
ctx.baseUrl = pathToFileURL(path.dirname(rootConfig)).href + '/';
const dshHome = resolveDshHome();
ctx.provide('dshHomePath', (rel) => path.join(dshHome, rel));

await ctx.plugin(Loader);

// Replicate runProfile's host prepare callback: provide launch env + cmdlineArgs.
ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, { appName: 'dsh', profile: 'web', args: [] });
provideCmdline(ctx, {
  args: ['--port', '7077'],
  exit: () => {},
  ready: { onReady() {} }
});

const homePatchPath = path.join(dshHome, 'cordis.patch.yml');
const patches = [
  ...(profile.layers ? profile.layers.flatMap((l) => l.patches || []) : []),
  ...(profile.patches || []),
  ...(loadOptionalPatches(NAME, homePatchPath) || []),
];
console.log('nLayers=' + (profile.layers ? profile.layers.length : 0) + ' layerPackages=' + (profile.layers ? profile.layers.map((l) => l.packageName).join(',') : ''));

try {
  await mountRootInclude(ctx, rootConfig, structuredClone(patches), undefined);
} catch (e) {
  console.log('mountRootInclude ERROR: ' + (e && e.stack || e));
}

await new Promise((r) => setTimeout(r, 25000));

const loader = ctx.get('loader');
console.log('--- loader present=' + (!!loader) + ' ---');
if (loader) {
  let pending = 0, failed = 0, active = 0;
  for (const entry of loader.entries()) {
    const fiber = entry.fiber;
    const state = fiber ? fiber.state : 'no-fiber';
    let missing = [];
    if (fiber && fiber.inject) {
      missing = Object.keys(fiber.inject).filter((s) => ctx.get(s) === undefined);
    }
    const opts = entry.options || {};
    if (state === 0) pending++;
    else if (state === 3) failed++;
    else if (state === 2) active++;
    if (state !== 2) console.log(`[${String(state).padEnd(8)}] disabled=${!!entry.disabled} name=${opts.name || '(anon)'} id=${opts.id || '-'} missing=${missing.join(',') || '-'}`);
  }
  console.log(`SUMMARY active=${active} pending=${pending} failed=${failed}`);
}
console.log('--- done ---');
process.exit(0);
