// Automated gate: verify the installed dsh-runtime's default LLM provider registry
// contains only deepseek-harness native models (no aliyun/qwen/dashscope/hardcoded keys).
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DSH_RUNTIME = 'D:/DeepSeekAgent/resources/dsh-runtime';

// The deployed runtime ships every @deepseek-ai/* package as a dot-prefixed
// hashed dir (e.g. `.dsh-llm-deepseek-XXXX`) with NO proper-name entry, so the
// logical name must be resolved by reading each dir's package.json `name`.
function resolveHashedPackage(scopeDir, pkgName) {
  for (const entry of readdirSync(scopeDir)) {
    const dir = join(scopeDir, entry);
    let name;
    try { name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name } catch { continue }
    if (name === pkgName) return dir
  }
  throw new Error(`package not found in runtime: ${pkgName}`)
}

const llmDir = resolveHashedPackage(join(DSH_RUNTIME, 'node_modules/@deepseek-ai'), '@deepseek-ai/dsh-llm-deepseek');
const pkgJson = JSON.parse(readFileSync(join(llmDir, 'package.json'), 'utf8'));
const main = join(llmDir, pkgJson.main || 'lib/index.js');
// Static source inspection only — importing the module fails because its hashed
// dir cannot resolve sibling `@deepseek-ai/*` packages by proper name under
// plain Node (only the host Cordis loader can). The gate only needs constants.
const source = readFileSync(main, 'utf8');

function extractStringConst(name) {
  const re = new RegExp(`const ${name}\\s*=\\s*"([^"]+)";`, 'm');
  const m = source.match(re);
  return m ? m[1] : undefined;
}

function extractModelIds() {
  const blockRe = /const DEFAULT_MODELS\s*=\s*(\[[\s\S]*?\]);/m;
  const block = source.match(blockRe);
  if (!block) return [];
  const ids = [];
  const idRe = /id:\s*"([^"]+)"/g;
  let m;
  while ((m = idRe.exec(block[1])) !== null) ids.push(m[1]);
  return ids;
}

const modelIds = extractModelIds();
const PROVIDER = extractStringConst('PROVIDER');
const DEFAULT_API_KEY_ENV = extractStringConst('DEFAULT_API_KEY_ENV');
const PUBLIC_BASE_URL = extractStringConst('PUBLIC_BASE_URL');

const forbidden = ['dashscope', 'aliyuncs', 'qwen', 'aliyun'];
const leaks = ['1d652041', 'CML53A1HXWSC7YUE'];

let ok = true;

console.log('=== dsh-llm-deepseek default provider inspection ===');
console.log('PROVIDER:', PROVIDER);
console.log('PUBLIC_BASE_URL:', PUBLIC_BASE_URL);
console.log('DEFAULT_API_KEY_ENV:', DEFAULT_API_KEY_ENV);
console.log('DEFAULT_MODELS count:', modelIds.length);

if (PROVIDER !== 'deepseek-official') {
  console.error('FAIL: PROVIDER is not deepseek-official:', PROVIDER);
  ok = false;
}
if (PUBLIC_BASE_URL !== 'https://api.deepseek.com') {
  console.error('FAIL: PUBLIC_BASE_URL is not https://api.deepseek.com:', PUBLIC_BASE_URL);
  ok = false;
}
if (DEFAULT_API_KEY_ENV !== 'DEEPSEEK_API_KEY') {
  console.error('FAIL: DEFAULT_API_KEY_ENV is not DEEPSEEK_API_KEY:', DEFAULT_API_KEY_ENV);
  ok = false;
}

for (const id of modelIds) {
  console.log('  model:', id);
  const lower = String(id).toLowerCase();
  for (const bad of forbidden) {
    if (lower.includes(bad)) {
      console.error(`FAIL: model id contains forbidden substring "${bad}": ${id}`);
      ok = false;
    }
  }
}

if (modelIds.length === 0) {
  console.error('FAIL: DEFAULT_MODELS is empty');
  ok = false;
}

for (const leak of leaks) {
  if (source.includes(leak)) {
    console.error('FAIL: hardcoded key leak found in module source:', leak);
    ok = false;
  }
}

console.log('');
if (ok) {
  console.log('PASS: default provider registry is clean (deepseek-harness native only)');
  process.exit(0);
} else {
  console.error('FAIL: default provider registry contains non-deepseek defaults or leaks');
  process.exit(1);
}
