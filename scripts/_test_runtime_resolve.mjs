import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const NM = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules';
const req = createRequire(path.join(NM, 'x.js'));
const names = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-market', '@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh', '@deepseek-ai/dsh-lsp', '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-web-app'];
for (const n of names) {
  let out = 'FAIL';
  try {
    const pj = req.resolve(n + '/package.json');
    const real = fs.realpathSync(path.dirname(pj));
    out = 'OK  realpath=' + real.replace('D:\\DeepSeekAgent\\resources\\dsh-runtime\\node_modules\\@deepseek-ai\\', '') ;
  } catch (e) { out = 'FAIL ' + e.code; }
  console.log(n.padEnd(38), out);
}

// 逐个 junction 打印 readlink
const DIR = path.join(NM, '@deepseek-ai');
for (const n of ['dsh-agent', 'dsh-acp', 'dsh-market']) {
  const p = path.join(DIR, n);
  const st = fs.lstatSync(p);
  console.log('\n' + n, 'isSymlink=', st.isSymbolicLink(), 'isDir=', st.isDirectory());
  if (st.isSymbolicLink()) console.log('  readlink =', JSON.stringify(fs.readlinkSync(p)));
  console.log('  realpath =', fs.realpathSync(p));
}
