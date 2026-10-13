// probe-prepare.mjs —— 隔离验证 prepareDshHome 是否挂死（分步计时）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LAUNCHER = 'D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs';
const EXT = 'D:/DeepSeekAgent/resources/packages/extensions';
const launcher = require(LAUNCHER);
const HOME = path.join(os.tmpdir(), 'dsh-home-probe-' + Date.now());
const t0 = Date.now();
const T = (m) => console.log(`[+${Date.now() - t0}ms] ${m}`);
const to = setTimeout(() => { T('HARD-TIMEOUT'); process.exit(137); }, 30000);
T('start');
T('readCommunityPlugins...');
const plugins = launcher.readCommunityPlugins(EXT);
T('plugins=' + JSON.stringify(plugins.map((p) => p.name)));
T('mkdir HOME');
fs.mkdirSync(HOME, { recursive: true });
T('prepareDshHome...');
try { launcher.prepareDshHome({ extensionsDir: EXT, dshHome: HOME, profileName: 'web' }); T('prepareDshHome OK'); }
catch (e) { T('prepareDshHome THREW: ' + (e && e.message)); }
T('list profile node_modules');
try { const nm = path.join(HOME, 'profiles', 'web', 'node_modules', '@deepseek-ai'); T('junction targets: ' + fs.readdirSync(nm).join(',')); } catch (e) { T('list err: ' + e.message); }
fs.rmSync(HOME, { recursive: true, force: true });
clearTimeout(to);
T('DONE');
process.exit(0);
