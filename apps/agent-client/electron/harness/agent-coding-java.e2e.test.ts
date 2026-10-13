/**
 * Harness 多轮会话 + 自动编码（Java JDK8 Maven 教学项目）端到端验证（e2e，走智谱/Zhipu）。
 *
 * - 真实驱动 HarnessApp 的 Agent Loop（与 GUI 的 harness-chat 同源代码路径）：
 *   通过工具 fs__write_file 把生成的代码落盘，再用 fs__run_command 运行验证（mvn）。
 * - 真实调用智谱 OpenAI 兼容端点（https://open.bigmodel.cn/api/paas/v4），
 *   默认使用 config.ts 内建兜底 Key；速率闸门由 DeepSeekAdapter 强制 60s（≤1 次/60s）。
 * - 默认跳过（避免污染默认单测套件 / 误触外部 API），需显式开启：
 *     DSH_RUN_E2E=1 npx vitest run electron/harness/agent-coding-java.e2e.test.ts
 *
 * 验证目标（对应「多轮会话 + 生成 Java JDK8 Maven 项目 + 编译运行 + bug 修复 + 交付 + 总结」）：
 *   ① 多轮①：生成完整可运行的 Java JDK8 Maven 项目（pom.xml + 主类 + JUnit 测试）并落盘。
 *   ② 多轮②：用 mvn 编译并运行测试；若失败，agent 自行读 Maven 输出、定位根因、修复源文件、重跑，
 *             直到 BUILD SUCCESS（覆盖「编译运行 + bug 修复」）。
 *   ③ 多轮③：编写 README.md 并完成「交付总结」（覆盖「最终交付 + 完成总结」）。
 *   全程 3 轮对话，第 ②/③ 轮基于第 ① 轮落盘的文件，验证上下文/任务连续性。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { HarnessApp, loadHarnessConfig, type HarnessConfig } from './app';

// 确保 Windows 下 exec→cmd.exe 能找到 mvn.cmd，且 Maven 使用可编译 Java 8 的 JDK。
const MAVEN_BIN = 'D:\\software\\apache-maven-3.9.12\\bin';
if (!process.env.PATH.includes(MAVEN_BIN)) {
  process.env.PATH = `${MAVEN_BIN};${process.env.PATH}`;
}
process.env.JAVA_HOME = process.env.JAVA_HOME || 'D:\\software\\jdk-17.0.19+10';
// 智谱 Key（config.ts 内置兜底，这里显式注入更稳妥）
process.env.ZHIPU_API_KEY =
  process.env.ZHIPU_API_KEY || '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 递归统计工作目录内 .java 文件数量。 */
function countJava(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countJava(p);
    else if (e.name.endsWith('.java')) n += 1;
  }
  return n;
}

describe.skipIf(!process.env.DSH_RUN_E2E)(
  'Harness 多轮 + 自动编码 Java JDK8 Maven 项目 e2e (Zhipu)',
  () => {
    let app: HarnessApp;
    let workDir: string;
    let agentId: string;
    const writeResults: string[] = [];
    const runResults: string[] = [];
    let model = 'glm-4.7-flash';

    beforeAll(async () => {
      const base = loadHarnessConfig(process.env);
      model = (process.env.ZHIPU_PRIMARY_MODEL || base.model || 'glm-4.7-flash')
        .split(',')[0]
        .trim();

      workDir = mkdtempSync(path.join(tmpdir(), 'dsh-java-'));
      const cfg: HarnessConfig = {
        ...base,
        apiKey: base.apiKey || process.env.ZHIPU_API_KEY || '',
        baseUrl: base.baseUrl.includes('bigmodel')
          ? base.baseUrl
          : 'https://open.bigmodel.cn/api/paas/v4',
        model,
        rateLimitMs: 60_000,
        workDir,
        permission: 'execute',
        persistenceType: 'memory',
      };
      expect(cfg.apiKey, '未找到智谱 API Key（请在 .env 配置 ZHIPU_API_KEY 或依赖内置兜底）').toBeTruthy();

      app = new HarnessApp(cfg);
      await app.start();

      // 捕获工具结果事件：落盘 / 运行
      app.ctx.on('session/event', (_s: unknown, ev: any) => {
        if (ev?.type === 'tool/result' && ev.data?.name === 'fs__write_file') {
          writeResults.push(ev.data.message?.content.map((b: any) => b.text).join('') ?? '');
        }
        if (ev?.type === 'tool/result' && ev.data?.name === 'fs__run_command') {
          runResults.push(ev.data.message?.content.map((b: any) => b.text).join('') ?? '');
        }
      });

      const agent = app.createAgent({ cwd: workDir, model, maxToolSteps: 50 });
      agentId = agent.id;
    }, 120_000);

    afterAll(() => {
      try {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        void app?.stop();
      } catch {
        /* ignore */
      }
    });

    /** 发送一条消息并等待 agent 回到 idle（单轮完成）。 */
    async function runTurn(text: string, timeoutMs = 1_800_000): Promise<void> {
      const agent = app.getAgent(agentId)!;
      const start = Date.now();
      agent.followup([{ type: 'text', text }]);
      // 等待进入 running
      while (Date.now() - start < 30_000 && agent.status === 'idle') await sleep(300);
      // 等待回到 idle
      while (Date.now() - start < timeoutMs && agent.status === 'running') await sleep(1_000);
      if (agent.status === 'running') throw new Error('turn 未在超时内完成');
    }

    it('多轮①：生成 Java JDK8 Maven 教学项目（落盘 pom + 源码 + 测试）', async () => {
      const prompt =
        '请在工作目录创建一个「Java JDK8 教学 Maven 项目」，要求通过 fs__write_file 工具真实落盘：\n' +
        '1) pom.xml：groupId=com.example, artifactId=java8-teaching, version=1.0.0, packaging=jar；' +
        '配置 maven-compiler-plugin 以 <release>8</release> 面向 Java 8 编译；引入 JUnit 5（junit-jupiter）作为 test 依赖。\n' +
        '2) 主类 src/main/java/com/example/teaching/App.java：含 public static void main，' +
        '打印欢迎语，并演示一个小算法（如 FizzBuzz 前 20 项或数组求和/过滤），代码要有清晰中文注释。\n' +
        '3) 测试 src/test/java/com/example/teaching/AppTest.java：用 JUnit 5 对算法写至少 2 个断言。\n' +
        '请直接创建文件，不要只把代码放在对话里。创建完成后用 fs__list_dir 列出工作目录确认结构。';

      await runTurn(prompt);

      // 断言：pom.xml 落盘
      expect(existsSync(path.join(workDir, 'pom.xml')), 'pom.xml 未落盘').toBe(true);
      // 断言：生成了 .java 源文件
      expect(countJava(workDir), '未生成任何 .java 源文件').toBeGreaterThan(0);
      // 断言：pom 面向 Java 8 且含 compiler 插件
      const pom = readFileSync(path.join(workDir, 'pom.xml'), 'utf8');
      expect(pom, 'pom 缺少 maven-compiler-plugin').toMatch(/maven-compiler-plugin/);
      expect(
        pom.toLowerCase(),
        'pom 未配置 Java 8 编译（release/source/target 8）',
      ).toMatch(/release>8|source>8|target>8/);
      // 断言：确有 fs__write_file 工具调用
      expect(writeResults.length, '未捕获到 fs__write_file 工具调用').toBeGreaterThan(0);
    }, 900_000);

    it('多轮②：编译并运行测试（mvn test），若失败则修复直至 BUILD SUCCESS', async () => {
      const prompt =
        '请用 fs__run_command 运行：mvn -q test（建议 timeoutMs 传 300000，避免 Maven 首次下载依赖超时），' +
        '关注输出是否出现 BUILD SUCCESS。\n' +
        '如果编译报错或测试失败，请根据 Maven 输出的根因，用 fs__write_file 修复对应源文件，' +
        '然后重新运行 mvn -q test，循环直到 BUILD SUCCESS。\n' +
        '最终把最后一轮 mvn 的关键结论（是否 BUILD SUCCESS、跑了几个测试）告诉我。';

      await runTurn(prompt);

      expect(runResults.length, '未捕获到 fs__run_command 工具调用（运行环节缺失）').toBeGreaterThan(0);
      const lastRun = runResults[runResults.length - 1];
      // 退出码必须为 0（运行无异常）
      expect(lastRun, '运行结果缺少 exitCode 字段').toMatch(/exitCode:\s*0/);
      // Maven 必须构建成功
      expect(
        lastRun,
        `mvn 未成功构建（最后一轮输出）：\n${lastRun.slice(0, 1500)}`,
      ).toMatch(/BUILD SUCCESS/);
    }, 900_000);

    it('多轮③：编写 README 并完成交付总结', async () => {
      const prompt =
        '请用 fs__write_file 在工作目录创建 README.md，内容包含：\n' +
        '项目简介、JDK8 / Maven 环境要求、构建与运行命令（mvn test / mvn package）、' +
        '源码结构说明、以及一段「本次交付总结」（说明创建了哪些文件、如何验证通过）。\n' +
        '写完后用一句话向我汇报交付完成。';

      await runTurn(prompt);

      expect(existsSync(path.join(workDir, 'README.md')), 'README.md 未落盘').toBe(true);
      const readme = readFileSync(path.join(workDir, 'README.md'), 'utf8');
      expect(readme.length, 'README.md 内容过短').toBeGreaterThan(100);
      expect(readme, 'README 缺少交付总结').toMatch(/交付总结|总结/);
    }, 900_000);
  },
);
