// 验证 deepseek-official provider 在 DashScope（OpenAI 兼容）端点下，
// 对未收录的 qwen/deepseek 系列模型把默认输出上限从 256k 锁到 8192，
// 避免触发 DashScope "Range of max_tokens should be [1, 65536]"。
//
// 直接加载【部署运行时】的真实编译产物（即用户 exe 实际加载的代码），
// 确保运行时行为被正确覆盖。
import { pathToFileURL } from 'node:url';

const DEPLOYED_ADAPTER = 'D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js';

const { DeepSeekAdapter } = await import(pathToFileURL(DEPLOYED_ADAPTER).href);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name} :: ${detail}`);
    console.log(`  FAIL  ${name} :: ${detail}`);
  }
}

function makeConfig({ baseURL, models = [], maxTokens = 256_000 }) {
  return {
    options() {
      return {
        baseURL,
        apiKeyEnv: { ref: 'DEEPSEEK_API_KEY' },
        defaults: { thinking: 'enabled', reasoningEffort: 'high' },
        maxTokens,
        defaultContextWindow: 64_000,
        models,
      };
    },
    resolveFiles: () => ({}), // 避免构造 DeepSeekFileStore，纯测 modelInfoFor
  };
}

async function resolveDefaultMaxTokens(cfg, model) {
  const adapter = new DeepSeekAdapter(cfg);
  const info = await adapter.resolveModel('deepseek', model);
  return info.defaultMaxTokens;
}

console.log('[qwen-max-tokens] DashScope 端点未收录模型兜底上限');

// 1) DashScope + 未收录 qwen -> 必须钳到 8192
{
  const v = await resolveDefaultMaxTokens(
    makeConfig({ baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    'qwen3.6-plus'
  );
  check('DashScope 未收录 qwen3.6-plus 钳到 8192', v === 8192, `got ${v}`);
}

// 2) DashScope + 未收录 deepseek -> 必须钳到 8192
{
  const v = await resolveDefaultMaxTokens(
    makeConfig({ baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    'deepseek-chat'
  );
  check('DashScope 未收录 deepseek-chat 钳到 8192', v === 8192, `got ${v}`);
}

// 3) DashScope + 已收录（目录内置）qwen -> 用其自身 maxTokens(8192)，不被二次改写
{
  const v = await resolveDefaultMaxTokens(
    makeConfig({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ id: 'qwen3.6-plus', maxTokens: 8192 }],
    }),
    'qwen3.6-plus'
  );
  check('DashScope 已收录 qwen3.6-plus 保持目录 maxTokens 8192', v === 8192, `got ${v}`);
}

// 4) 非 DashScope 端点（如官方 DeepSeek）+ 未收录 qwen -> 不钳制，保持默认 256k
{
  const v = await resolveDefaultMaxTokens(
    makeConfig({ baseURL: 'https://api.deepseek.com/v1' }),
    'qwen3.6-plus'
  );
  check('非 DashScope 端点不钳制（保持 256000）', v === 256_000, `got ${v}`);
}

// 5) DashScope + 与 qwen/deepseek 无关的未收录模型 -> 不钳制（模型名校验门）
{
  const v = await resolveDefaultMaxTokens(
    makeConfig({ baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    'gpt-4o'
  );
  check('DashScope 非 qwen/deepseek 模型不钳制（保持 256000）', v === 256_000, `got ${v}`);
}

console.log(`\n[qwen-max-tokens] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('[qwen-max-tokens] ALL GREEN');
