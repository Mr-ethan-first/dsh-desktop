// 单元验证：用 qwen-turbo 在 DashScope 上真实出现的「第二片 name:""」流，
// 喂给已修复的 translate，确认最终 tool-call 块 name 不为空。
import { pathToFileURL } from 'node:url';
const translateMod = await import(pathToFileURL('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/types/translate.js').href);
const { translate } = translateMod;

// 模拟 DashScope 对 qwen-turbo 的 tool_calls 流式分片
const payloads = [
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0a97f6aa48e84b079473c7', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] }),
  // 关键：qwen-turbo 在第二片回传 name:""（已定义但为空）
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_0a97f6aa48e84b079473c7', type: 'function', function: { name: '', arguments: '' } }] } }] }),
  // 续片：id:"" 且省略 name
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: '{"content": "<!DOCTYPE html>"' } }] } }] }),
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', type: 'function', function: { arguments: '}' } }] } }] }),
  JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
  '[DONE]',
];

async function main() {
  const blocks = [];
  for await (const chunk of translate((async function* () { for (const p of payloads) yield p; })())) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      blocks.push(chunk.block);
    }
  }
  const tc = blocks[0];
  console.log('FINAL_TOOL_CALL:', JSON.stringify(tc));
  if (tc && tc.name && tc.name.length > 0 && tc.id && tc.id.length > 0) {
    console.log('PASS: name=' + tc.name + ' id=' + tc.id);
    process.exit(0);
  } else {
    console.log('FAIL: empty name or id');
    process.exit(1);
  }
}
main().catch((e) => { console.error('ERR', e); process.exit(2); });
