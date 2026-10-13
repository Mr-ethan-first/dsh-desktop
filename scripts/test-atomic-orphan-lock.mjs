// 验证 dsh-atomic-write 的 withFileLock 在遭遇「孤儿锁」（持有者 PID 已死亡的锁文件）
// 时会自动清除并继续获取，而不是无限等待 2s 后抛错。
// 这直接修复了 dsh web 启动因历史崩溃留下的孤儿 node_modules.lock 而卡死的问题。
//
// 直接加载【部署运行时】的真实模块（该模块仅依赖 node:fs，无外部依赖）。
import { pathToFileURL } from 'node:url';
import { writeFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ATOMIC = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js';
const { withFileLock } = await import(pathToFileURL(ATOMIC).href);

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name} :: ${detail}`); }
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-test-'));
const target = join(dir, 'node_modules'); // 锁文件 = node_modules.lock

console.log('[atomic-orphan-lock] withFileLock 孤儿锁自愈');

// 1) 正常获取/释放
let ran1 = false;
await withFileLock(target, async () => { ran1 = true; });
check('正常：operation 执行', ran1 === true);
check('正常：锁在用完后被移除', (await exists(join(dir, 'node_modules.lock'))) === false);

// 2) 孤儿锁（死的 PID）自动清除后继续
const lockPath = join(dir, 'node_modules.lock');
await writeFile(lockPath, '400000\n', { mode: 0o600 }); // 400000 几乎必然是已死亡的 PID
let ran2 = false;
await withFileLock(target, async () => { ran2 = true; });
check('孤儿锁：清除死 PID 锁后 operation 执行', ran2 === true);
check('孤儿锁：锁在用完后被移除', (await exists(lockPath)) === false);

// 3) 重新写入一个孤儿锁，确认再次自愈（连续崩溃场景）
await writeFile(lockPath, '400001\n', { mode: 0o600 });
let ran3 = false;
await withFileLock(target, async () => { ran3 = true; });
check('孤儿锁（再次）：仍自愈并执行业务', ran3 === true);

await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`\n[atomic-orphan-lock] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('[atomic-orphan-lock] ALL GREEN');
