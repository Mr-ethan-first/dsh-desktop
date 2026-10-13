// Replicate `dsh web` boot with a manual timeout, then dump every cordis entry's
// fiber state + unsatisfied injects. Reveals which entry is PENDING (causing the silent hang).
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

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
const launcher = require('D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs');

const DSH_HOME = 'D:/WorkSpace/deepseek-harness-master/_tmp_bootdump_' + Date.now();
fs.mkdirSync(DSH_HOME, { recursive: true });
launcher.prepareDshHome({ extensionsDir: 'D:/DeepSeekAgent/resources/packages/extensions', dshHome: DSH_HOME, profileName: 'web' });
process.env.DSH_HOME = DSH_HOME;

const INSTALL_ANCHOR = RG + '/dsh/package.json';
const NAME = 'dsh';
let profile;
try {
  profile = loadProfile(NAME, 'web', INSTALL_ANCHOR, undefined, { userLayer: true });
} catch (e) {
  console.log('loadProfile ERROR: ' + (e && e.stack || e));
  process.exit(1);
}
const rootConfig = profile.patchPath;
console.log('rootConfig=' + rootConfig + ' exists=' + fs.existsSync(rootConfig));

const ctx = new Context();
ctx.baseUrl = pathToFileURL(path.dirname(rootConfig)).href + '/';
const dshHome = resolveDshHome();
ctx.provide('dshHomePath', (rel) => path.join(dshHome, rel));

await ctx.plugin(Loader);

const homePatchPath = path.join(dshHome, 'cordis.patch.yml');
const patches = [
  ...(profile.layers ? profile.layers.flatMap((l) => l.patches || []) : []),
  ...(profile.patches || []),
  ...(loadOptionalPatches(NAME, homePatchPath) || []),
];

try {
  await mountRootInclude(ctx, rootConfig, structuredClone(patches), undefined);
} catch (e) {
  console.log('mountRootInclude ERROR: ' + (e && e.stack || e));
}

await new Promise((r) => setTimeout(r, 20000));

const loader = ctx.get('loader');
console.log('--- loader present=' + (!!loader) + ' ---');
if (loader) {
  for (const entry of loader.entries()) {
    const fiber = entry.fiber;
    const state = fiber ? fiber.state : 'no-fiber';
    let missing = [];
    if (fiber && fiber.inject) {
      missing = Object.keys(fiber.inject).filter((s) => ctx.get(s) === undefined);
    }
    const opts = entry.options || {};
    console.log(`[${String(state).padEnd(8)}] disabled=${!!entry.disabled} name=${opts.name || '(anon)'} id=${opts.id || '-'} missing=${missing.join(',') || '-'}`);
  }
}
console.log('--- done ---');
process.exit(0);
