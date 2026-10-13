import { readFileSync, existsSync } from 'node:fs';
const dbPath = process.argv[2];
if (!dbPath || !existsSync(dbPath)) { console.error('db not found:', dbPath); process.exit(1); }
const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f) => new URL(`../node_modules/sql.js/dist/${f}`, import.meta.url).href });
const db = new SQL.Database(readFileSync(dbPath));
console.log('=== TABLES ===');
for (const r of db.exec("SELECT name FROM sqlite_master WHERE type='table'")) {
  for (const v of r.values) console.log(' ', v[0]);
}
console.log('=== sessions ===');
try {
  const r = db.exec('SELECT id, created_at, updated_at, cwd, title, version, event_count FROM sessions');
  if (r[0]) for (const v of r[0].values) console.log(JSON.stringify(v));
  else console.log('  (空)');
} catch (e) { console.log('  err:', e.message); }
console.log('=== session_events count by session ===');
try {
  const r = db.exec('SELECT session_id, COUNT(*) c FROM session_events GROUP BY session_id');
  if (r[0]) for (const v of r[0].values) console.log(' ', v[0], 'events=', v[1]);
  else console.log('  (空)');
} catch (e) { console.log('  err:', e.message); }
db.close();