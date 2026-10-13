/**
 * Harness Agent 多轮会话 + 智能编码落盘 + 运行 自动化验证（e2e）
 *
 * - 真实驱动 HarnessApp 的 Agent Loop（与 GUI 的 harness-chat 同源代码路径），
 *   通过工具 fs__write_file 把生成的代码落盘，再用 fs__run_command 运行验证。
 * - 真实调用阿里 DashScope（qwen3-coder-plus），依赖项目 .env 中的 ALIYUN_API_KEYS。
 * - 默认跳过（避免污染默认单测套件 / 误触外部 API），需显式开启：
 *     DSH_RUN_E2E=1 npx vitest run electron/harness/agent-coding.e2e.test.ts
 *
 * 验证目标（对应「多轮会话无问题、生成大的代码落盘且运行没有异常、功能都正常」）：
 *   1) 多轮：连续两轮对话，第二轮基于第一轮落盘的文件进行运行验证（上下文/任务连续性正常）。
 *   2) 落盘：生成 ≥ 150 行的完整可运行代码，并写入工作目录磁盘。
 *   3) 运行：fs__run_command 调用 node 运行该脚本，退出码为 0 且自测通过标记出现。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HarnessApp, loadHarnessConfig, type HarnessConfig } from './app';

const DASHSCOPE_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 从候选 .env 文件注入环境变量（仅填充尚未存在的键）。 */
function loadDotEnv(): boolean {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

const hasKey = loadDotEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DSH_RUN_E2E)('Harness Agent 多轮会话 + 智能编码落盘 + 运行 e2e', () => {
  let app: HarnessApp;
  let workDir: string;
  let agentId: string;
  const writeResults: string[] = [];
  const runResults: string[] = [];
  let model = 'qwen3-coder-plus';

  beforeAll(async () => {
    const base = loadHarnessConfig(process.env);
    model = (process.env.ZHIPU_PRIMARY_MODEL || process.env.ALIYUN_MODELS || 'qwen3-coder-plus')
      .split(',')[0]
      .trim() || 'qwen3-coder-plus';

    workDir = mkdtempSync(path.join(tmpdir(), 'dsh-code-'));
    const cfg: HarnessConfig = {
      ...base,
      apiKey: base.apiKey || (process.env.ALIYUN_API_KEYS || '').split(',')[0]?.trim() || '',
      baseUrl: base.baseUrl.includes('dashscope') || !base.apiKey ? DASHSCOPE_BASE : base.baseUrl,
      model,
      workDir,
      persistenceType: 'memory',
    };
    expect(cfg.apiKey, '未找到阿里云 API Key（请在 .env 配置 ALIYUN_API_KEYS）').toBeTruthy();

    app = new HarnessApp(cfg);
    await app.start();

    // 捕获工具结果事件
    app.ctx.on('session/event', (_s: unknown, ev: { type: string; data?: { name?: string; message?: { content: Array<{ type: string; text: string }> } } }) => {
      if (ev?.type === 'tool/result' && ev.data?.name === 'fs__write_file') {
        writeResults.push(ev.data.message?.content.map((b) => b.text).join('') ?? '');
      }
      if (ev?.type === 'tool/result' && ev.data?.name === 'fs__run_command') {
        runResults.push(ev.data.message?.content.map((b) => b.text).join('') ?? '');
      }
    });

    const agent = app.createAgent({ cwd: workDir, model });
    agentId = agent.id;
  }, 60_000);

  afterAll(() => {
    try {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** 发送一条消息并等待 agent 回到 idle（单轮完成）。 */
  async function runTurn(text: string, timeoutMs = 300_000): Promise<void> {
    const agent = app.getAgent(agentId)!;
    const start = Date.now();
    agent.followup([{ type: 'text', text }]);
    // 等待进入 running
    while (Date.now() - start < 20_000 && agent.status === 'idle') await sleep(300);
    // 等待回到 idle
    while (Date.now() - start < timeoutMs && agent.status === 'running') await sleep(1_000);
    if (agent.status === 'running') throw new Error('turn 未在超时内完成');
  }

  it('多轮 + 落盘：生成大段可运行代码并写入磁盘', async () => {
    const prompt =
      '请使用工具 fs__write_file 在工作目录创建一个名为 solution.js 的文件。' +
      '内容是一个完整、可运行的 Node.js 程序（CommonJS 或 ESM 均可），要求：\n' +
      '1) 实现一个小型但完整的「任务调度器」模块，包含至少 3 个相互调用的函数、参数校验、错误处理、清晰的注释；\n' +
      '2) 代码总行数不少于 150 行；\n' +
      '3) 文件末尾用 node:assert 编写一组单元测试，覆盖正常与边界情况，并在全部断言通过后打印唯一成功标记：ALL_TESTS_PASSED。\n' +
      '请务必通过 fs__write_file 工具落盘，不要只把代码放在对话里。';

    await runTurn(prompt);

    // 断言：工作目录确实生成了代码文件，且体积足够大（对应「大的代码落盘」）
    const files = readdirSync(workDir).filter((f) => f.endsWith('.js'));
    expect(files.length, '未在工作目录发现任何 .js 文件（落盘失败）').toBeGreaterThan(0);

    let maxSize = 0;
    let maxFile = '';
    for (const f of files) {
      const size = statSync(path.join(workDir, f)).size;
      if (size > maxSize) {
        maxSize = size;
        maxFile = f;
      }
    }
    expect(maxSize, `落盘文件体积过小（${maxSize} 字节），未达「大段代码」要求`).toBeGreaterThan(1500);
    const content = readFileSync(path.join(workDir, maxFile), 'utf8');
    expect(content.split('\n').length, '代码行数不足 150 行').toBeGreaterThanOrEqual(150);
    expect(writeResults.length, '未捕获到 fs__write_file 工具调用结果').toBeGreaterThan(0);
  }, 320_000);

  it('多轮 + 运行：基于已落盘文件运行，退出码 0 且测试通过', async () => {
    const prompt =
      '请用工具 fs__run_command 运行刚才写入的 solution.js（命令：node solution.js），' +
      '并确认输出中出现了 ALL_TESTS_PASSED。如果运行报错，请根据错误信息用 fs__write_file 修复 solution.js 后重新运行，直到通过为止。';

    await runTurn(prompt);

    expect(runResults.length, '未捕获到 fs__run_command 工具调用结果（运行环节缺失）').toBeGreaterThan(0);
    const lastRun = runResults[runResults.length - 1];
    // 退出码必须为 0（运行无异常）
    expect(lastRun, '运行结果缺少 exitCode 字段').toMatch(/exitCode:\s*0/);
    // 自测通过标记必须出现
    expect(lastRun, `运行输出未出现 ALL_TESTS_PASSED，输出：${lastRun.slice(0, 800)}`).toMatch(/ALL_TESTS_PASSED/);
  }, 320_000);
});
