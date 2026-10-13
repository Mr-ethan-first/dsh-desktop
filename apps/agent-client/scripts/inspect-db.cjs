const path = require('path');
const initSqlJs = require('D:/WorkSpace/deepseek-harness-master/apps/agent-client/node_modules/sql.js');
const fs = require('fs');
const dbFile = 'C:/Users/Administrator/.deepseek-harness/sessions.db';
initSqlJs({ locateFile: (f) => 'D:/WorkSpace/deepseek-harness-master/apps/agent-client/node_modules/sql.js/dist/' + f })
  .then((SQL) => {
    const bytes = fs.readFileSync(dbFile);
    const db = new SQL.Database(bytes);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('TABLES:', JSON.stringify(tables[0]?.values));
    const sessions = db.exec('SELECT id, created_at, cwd, title, version, event_count FROM sessions');
    console.log('SESSIONS count:', sessions.length ? sessions[0].values.length : 0);
    if (sessions.length) console.log('ROWS:', JSON.stringify(sessions[0].values, null, 1));
    const ev = db.exec('SELECT COUNT(*) AS c FROM session_events');
    console.log('EVENT ROWS:', ev.length ? ev[0].values[0][0] : 0);
    db.close();
  })
  .catch((e) => { console.error('ERR', e); process.exit(1); });