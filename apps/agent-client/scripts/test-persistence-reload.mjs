/**
 * 会话重启恢复测试：验证「会话持久化到 sqlite，重启后任务不消失」。
 * 用真实的 SessionStore + sql.js 持久化：
 *   1. 创建一个会话并追加事件（写入 sqlite）
 *   2. 完全销毁（dispose + 新 store 实例模拟重启）
 *   3. 用同一 DB 文件重新初始化 SessionStore，确认会话 + 事件被自动重放
 * 运行：node apps/agent-client/scripts/test-persistence-reload.mjs
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HD = 'D:/WorkSpace/deepseek-harness-master/apps/agent-client/electron/harness-dist';
const u = (file) => pathToFileURL(join(HD, file)).href;

const { Context } = await import(u('context.js'));
const { SessionStore, createSessionId } = await import(u('session.js'));
const { initSqlJsSessionPersistence } = await import(u('session-persistence.js'));

const tmp = mkdtempSync(join(tmpdir(), 'dsh-persist-test-'));
const dbPath = join(tmp, 'sessions.db');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name} ${extra}`); }
}

// ---- 第一次运行：创建会话并写入事件 ----
const ps1 = await initSqlJsSessionPersistence(dbPath);
check('persistence 初始化(sql.js可用)', !!ps1);
const ctx1 = new Context();
ctx1.plugin(SessionStore, { persistence: ps1, autoLoad: true });

const sid = createSessionId();
const session = ctx1.sessions.create(sid, { cwd: 'D:/test', title: '演示任务' });
check('创建会话', !!session, 'id=' + sid);

ctx1.sessions.appendEvent(sid, { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } });
ctx1.sessions.appendEvent(sid, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复内容' }] } } });
check('向会话追加 2 个事件', ctx1.sessions.get(sid).events.length === 2, '实际=' + ctx1.sessions.get(sid).events.length);

// 模拟重启：销毁 store1（不落盘删除，只是丢掉内存态），用同一 db 文件重建
await ctx1.dispose();
const dbBytes1 = statSync(dbPath).size;
check('sqlite 文件已落盘(非空)', dbBytes1 > 0, 'size=' + dbBytes1);

// ---- 第二次运行：从同一 sqlite 重新加载 ----
const ps2 = await initSqlJsSessionPersistence(dbPath);
const ctx2 = new Context();
ctx2.plugin(SessionStore, { persistence: ps2, autoLoad: true });

const reloaded = ctx2.sessions.get(sid);
check('重启后会话从 sqlite 恢复(不消失)', !!reloaded);
if (reloaded) {
  check('恢复的 cwd 正确', reloaded.header.cwd === 'D:/test', reloaded.header.cwd);
  check('恢复的 title 正确', reloaded.header.title === '演示任务', reloaded.header.title);
  check('恢复的事件数正确(2)', reloaded.events.length === 2, '实际=' + reloaded.events.length);
  const msgs = reloaded.getMessages();
  check('消息历史可回放(2条)', msgs.length === 2, '实际=' + msgs.length);
  check('首条消息为用户消息', msgs[0]?.role === 'user', msgs[0]?.role);
  console.log('  消息: ' + msgs.map((m) => m.role + '=' + m.content[0]?.text).join(' | '));
}
await ctx2.dispose();
rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);