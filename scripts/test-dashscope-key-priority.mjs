// 验证 dsh-web-launcher 的 buildDshWebEnv 在注入 deepseek-official provider 凭据时，
// 优先读取用户自定义阿里云 Key（DASHSCOPE_API_KEY / ALIYUN_API_KEY / ALIYUN_API_KEYS），
// 而非失效的内嵌硬编码 Key；三者都没有时才回退 DEEPSEEK_API_KEY / 内嵌 Key。
//
// 直接加载【部署运行时】的 electron 层 launcher（即 exe 主进程实际加载的代码）。
import { pathToFileURL } from 'node:url';

const LAUNCHER = 'D:/DeepSeekAgent/resources/app.asar.unpacked/electron/plugin-host/dsh-web-launcher.cjs';

const launcher = (await import(pathToFileURL(LAUNCHER).href)).default;
const buildDshWebEnv = launcher.buildDshWebEnv;

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

console.log('[dashscope-key-priority] buildDshWebEnv 凭据优先级');

// 1) DASHSCOPE_API_KEY 优先
{
  const env = buildDshWebEnv({ baseEnv: { DASHSCOPE_API_KEY: 'sk-user-dashscope' } });
  check('DASHSCOPE_API_KEY 优先注入 DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY === 'sk-user-dashscope', `got ${env.DEEPSEEK_API_KEY}`);
}

// 2) 无 DASHSCOPE 时 ALIYUN_API_KEY 次之
{
  const env = buildDshWebEnv({ baseEnv: { ALIYUN_API_KEY: 'sk-user-aliyun' } });
  check('ALIYUN_API_KEY 注入 DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY === 'sk-user-aliyun', `got ${env.DEEPSEEK_API_KEY}`);
}

// 3) ALIYUN_API_KEYS 逗号列表取第一个
{
  const env = buildDshWebEnv({ baseEnv: { ALIYUN_API_KEYS: 'sk-aliyun-1, sk-aliyun-2' } });
  check('ALIYUN_API_KEYS 取首项', env.DEEPSEEK_API_KEY === 'sk-aliyun-1', `got ${env.DEEPSEEK_API_KEY}`);
}

// 4) 仅有 DEEPSEEK_API_KEY 时保留原值
{
  const env = buildDshWebEnv({ baseEnv: { DEEPSEEK_API_KEY: 'sk-existing-deepseek' } });
  check('已有 DEEPSEEK_API_KEY 保留', env.DEEPSEEK_API_KEY === 'sk-existing-deepseek', `got ${env.DEEPSEEK_API_KEY}`);
}

// 5) 三者皆无 -> 回退到内嵌硬编码 Key（非空且以 sk-ws 开头）
{
  const env = buildDshWebEnv({ baseEnv: {} });
  check('全部缺失回退内嵌 Key', typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.startsWith('sk-ws'), `got ${env.DEEPSEEK_API_KEY}`);
}

// 6) DEEPSEEK_BASE_URL 默认重定向到 DashScope 兼容端点
{
  const env = buildDshWebEnv({ baseEnv: {} });
  check('DEEPSEEK_BASE_URL 默认指向 DashScope', env.DEEPSEEK_BASE_URL === 'https://dashscope.aliyuncs.com/compatible-mode/v1', `got ${env.DEEPSEEK_BASE_URL}`);
}

console.log(`\n[dashscope-key-priority] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('[dashscope-key-priority] ALL GREEN');
