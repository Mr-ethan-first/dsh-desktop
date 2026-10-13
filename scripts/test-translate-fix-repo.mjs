// 验证「构建源」仓库编译产物 packages/llm/llm-deepseek/lib/types/translate.js
// 喂 qwen-turbo 空名流，确认重建 exe 时 fix 不会丢失。
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('D:/WorkSpace/deepseek-harness-master/packages/llm/llm-deepseek/lib/types/translate.js').href);
const { translate } = mod;
const payloads = [
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0a97f6aa48e84b079473c7', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0a97f6aa48e84b079473c7', type: 'function', function: { name: '', arguments: '' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: '{"content": "<!DOCTYPE html>"' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: '}' } }] } }] }),
  JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
  '[DONE]',
];
const blocks = [];
for await (const c of translate(async function* () { for (const p of payloads) yield p; })()) {
  if (c.type === 'block-end' && c.block?.type === 'tool-call') blocks.push(c.block);
}
const tc = blocks[0];
console.log('REPO_LIB tool-call:', JSON.stringify(tc));
if (tc && tc.name && tc.name.length > 0 && tc.id && tc.id.length > 0) { console.log('REPO_LIB PASS'); process.exit(0); }
else { console.log('REPO_LIB FAIL'); process.exit(1); }
