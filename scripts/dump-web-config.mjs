// Dump the composed `dsh web` profile tree to see exactly which cordis entries
// (connection / webserver / api-* / directory-picker ...) get composed & resolve.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
const launcher = require('D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs');

const DSH_HOME = 'D:/WorkSpace/deepseek-harness-master/_tmp_dump_dsh_home';
fs.rmSync(DSH_HOME, { recursive: true, force: true });
fs.mkdirSync(DSH_HOME, { recursive: true });

launcher.prepareDshHome({
  extensionsDir: 'D:/DeepSeekAgent/resources/packages/extensions',
  dshHome: DSH_HOME,
  profileName: 'web',
});

const cliDir = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh';
const launch = launcher.resolveDshLaunch({ cliDir, extraBins: [cliDir + '/lib/bin.js'] });

const env = { ...process.env, DSH_HOME };
const r = spawnSync('D:/DeepSeekAgent/resources/node24/node.exe',
  [...launch.nodeArgs, launch.bin, 'web', '--dump-config'],
  { env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

const outFile = 'D:/WorkSpace/deepseek-harness-master/_tmp_dump_config.txt';
fs.writeFileSync(outFile,
  '=== STDOUT ===\n' + (r.stdout || '') + '\n=== STDERR ===\n' + (r.stderr || '') + '\n=== status=' + r.status + ' ===\n');
console.log('wrote ' + outFile);
console.log('--- STDOUT head ---');
console.log((r.stdout || '').slice(0, 4000));
console.log('--- STDERR head ---');
console.log((r.stderr || '').slice(0, 4000));
