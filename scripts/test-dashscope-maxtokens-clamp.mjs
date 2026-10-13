/**
 * 回归测试：验证 DashScope 端点上 qwen/deepseek 模型的 maxTokens
 * 即使被显式设置为 256000，也会在请求前被裁剪到 8192。
 *
 * 运行：node scripts/test-dashscope-maxtokens-clamp.mjs
 */
import { strict as assert } from 'node:assert';
import { DeepSeekAdapter, resolveAdapterOptions } from '../packages/llm/llm-deepseek/lib/index.js';

let capturedBody = null;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  capturedBody = JSON.parse(init.body);
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
};

function createAdapter(connection) {
  return new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => 'sk-test',
    resolveUserId: () => 'test-user',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
}

// contentHasImage() 要求 content 是 ContentBlock[] 数组（对 content 调 .some()），
// 真实链路里消息 content 本就是数组，故测试也用数组格式。
const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

async function run() {
  const cases = [
    { model: 'qwen3.6-plus', input: 256_000, expected: 8192, label: 'qwen3.6-plus 256000 -> 8192' },
    { model: 'qwen3.5-flash', input: 100_000, expected: 8192, label: 'qwen3.5-flash 100000 -> 8192' },
    { model: 'deepseek-v4-flash', input: 200_000, expected: 8192, label: 'deepseek-v4-flash 200000 -> 8192' },
    { model: 'qwen3.6-plus', input: 4096, expected: 4096, label: 'qwen3.6-plus 4096 保持' },
    { model: 'gpt-4', input: 256_000, expected: 256_000, label: '非 DashScope 模型不裁剪' },
  ];

  let passed = 0;
  for (const c of cases) {
    capturedBody = null;
    const connection = resolveAdapterOptions({
      baseURL: c.model.startsWith('gpt') ? 'https://api.openai.com' : DASHSCOPE_URL,
      models: [
        { id: 'qwen3.6-plus', maxTokens: 8192, contextWindow: 131072 },
        { id: 'qwen3.5-flash', maxTokens: 8192, contextWindow: 131072 },
        { id: 'deepseek-v4-flash', maxTokens: 8192, contextWindow: 65536 },
      ],
    }, {});
    const adapter = createAdapter(connection);
    try {
      const stream = adapter.stream({
        model: c.model,
        messages: MESSAGES,
        maxTokens: c.input,
      });
      // 消费一次让请求发出去
      await stream[Symbol.asyncIterator]().next();
    } catch (e) {
      console.error(`    [debug ${c.label}] error:`, e?.message || e);
    }
    assert(capturedBody, `${c.label}: request body should be captured`);
    assert.equal(
      capturedBody.max_tokens,
      c.expected,
      `${c.label}: expected max_tokens ${c.expected}, got ${capturedBody.max_tokens}`,
    );
    console.log(`  PASS  ${c.label}: max_tokens=${capturedBody.max_tokens}`);
    passed++;
  }

  globalThis.fetch = originalFetch;
  console.log(`\n[dashscope-maxtokens-clamp] ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
}

run().catch((e) => {
  globalThis.fetch = originalFetch;
  console.error(e);
  process.exit(1);
});
