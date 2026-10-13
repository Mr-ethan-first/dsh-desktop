/**
 * 确定性验证 fs 工具的路径越界防护（不依赖模型）。
 *
 * 直接构造一个最小 harness 上下文，注册真实 fs 工具，尝试用各种越界路径
 * 触发 fs__read_file / fs__write_file / fs__list_dir，断言全被拒绝且不泄漏。
 */
import fs from 'node:fs'
import path from 'node:path'
import { HarnessApp } from '../electron/harness/app.js'
import type { ToolExecutionResult } from '../electron/harness/tools.js'

const WORKROOT = path.resolve('apps', 'agent-client', '.eval-work', '_path-sec')

async function runTool(app: HarnessApp, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return (app.ctx.tools as any).execute(name, args, { agentId: 'sec-test' })
}

async function main(): Promise<void> {
  fs.rmSync(WORKROOT, { recursive: true, force: true })
  fs.mkdirSync(WORKROOT, { recursive: true })
  // 尤其构造 …/.. 归一化后可落到工作目录外的情况：目标必须在 workDir 之外
  const workDir = path.join(WORKROOT, 'work')
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(path.join(WORKROOT, 'outside.txt'), 'TOP-SECRET-OUTSIDE')

  const app = new HarnessApp({
    workDir,
    apiKey: 'x', baseUrl: 'x', model: 'x',
    maxParallelToolCalls: 1, permission: 'execute', persistenceType: 'memory',
  })
  await app.start()
  app.setWorkspace({ workDir })

  const attempts: Array<{ name: string; args: Record<string, unknown>; expect: 'reject' | 'allow' }> = [
    // 绝对路径（Windows / Unix）
    { name: 'fs__read_file', args: { relPath: 'C:/Windows/win.ini' }, expect: 'reject' },
    { name: 'fs__read_file', args: { relPath: path.resolve(WORKROOT, 'outside.txt') }, expect: 'reject' },
    // .. 归一化后越界
    { name: 'fs__read_file', args: { relPath: '..' + '/outside.txt' }, expect: 'reject' },
    { name: 'fs__read_file', args: { relPath: 'a/../../outside.txt' }, expect: 'reject' },
    // 写在越界位置
    { name: 'fs__write_file', args: { relPath: '../pwn.txt', content: 'x' }, expect: 'reject' },
    // list 越界
    { name: 'fs__list_dir', args: { relPath: '../' }, expect: 'reject' },
    // 工作目录内的正常操作应放行
    { name: 'fs__write_file', args: { relPath: 'ok.txt', content: 'ok' }, expect: 'allow' },
    { name: 'fs__list_dir', args: { relPath: '' }, expect: 'allow' },
  ]

  let pass = 0
  for (const a of attempts) {
    const res = await runTool(app, a.name, a.args)
    const joined = res.content.map((b) => (b as any).text || '').join(' ')
    const isError = res.isError || /Error|拒绝|越界|不允许|非法/i.test(joined)
    const ok = a.expect === 'reject' ? isError : !isError
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${a.expect.toUpperCase()}  ${a.name}(${JSON.stringify(a.args.relPath)})`)
    if (!ok) console.log(`       结果: ${joined.slice(0, 120)}`)
  }

  // 断言没有任何越界内容被写入工作目录外
  const outside = fs.existsSync(path.join(WORKROOT, 'outside.txt')) ? fs.readFileSync(path.join(WORKROOT, 'outside.txt'), 'utf8') : '(missing)'
  const outsideUntouched = outside === 'TOP-SECRET-OUTSIDE'
  const pwnExists = fs.existsSync(path.join(WORKROOT, 'pwn.txt'))
  console.log(`\n越界文件未被篡改=${outsideUntouched}；越界写文件被阻止=${!pwnExists}`)

  console.log(`\n== 路径越界防护：通过 ${pass}/${attempts.length} ==`)
  await app.stop()
  if (!(pass === attempts.length && outsideUntouched && !pwnExists)) {
    process.exit(1)
  }
}

main().catch((e) => { console.error('防护验证失败：', e); process.exit(1) })