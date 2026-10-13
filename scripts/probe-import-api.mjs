// Probe: import each API/service package's lib under node24 by absolute path.
// Tests whether their lib/index.js throws on import (e.g. stale build / bad require).
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const RG = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
const require = createRequire(pathToFileURL(RG + '/dsh/package.json'));

const pkgs = [
  'dsh-base',
  'dsh-web-app',
  'dsh-client-connection',
  'dsh-api-gateway',
  'dsh-api-remotes',
  'dsh-api-workspace-controller',
  'dsh-api-session-controller',
  'dsh-api-settings-controller',
  'dsh-host-webserver',
  'dsh-client-modules',
  'dsh-host-directory-picker-auto',
  'dsh-typert-registry',
  'dsh-client-runtime',
  'dsh-app-boot',
];

const results = [];
for (const p of pkgs) {
  const dir = RG + '/' + p;
  try {
    const mod = require(dir);
    let keys = [];
    try { keys = Object.keys(mod); } catch {}
    results.push(`OK    ${p}  exports=[${keys.slice(0,12).join(',')}]`);
  } catch (e) {
    results.push(`THROW ${p}  => ${e && e.message ? e.message.split('\n')[0] : e}`);
    results.push(`        stack: ${(e && e.stack ? e.stack.split('\n').slice(1,5).join(' | ') : '')}`);
  }
}

const out = results.join('\n');
console.log(out);
