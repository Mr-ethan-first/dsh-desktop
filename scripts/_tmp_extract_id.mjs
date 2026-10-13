import fs from 'node:fs';
const BASE = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai';
for (const [p, f] of [['dsh-node-flow', 'dsh-node-flow/lib/client.js'], ['dsh-market', 'dsh-market/client/client.js']]) {
  const t = fs.readFileSync(`${BASE}/${f}`, 'utf8');
  const m = t.match(/id:\s*['"][^'"]+['"]/);
  console.log(p, '->', m ? m[0] : '(not found)');
}
