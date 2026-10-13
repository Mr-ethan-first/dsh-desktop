#!/usr/bin/env node
/**
 * 后台任务收尾自检（2026-09-18 用户要求固化）
 *
 * 背景：用户发现 WorkBuddy 后台任务面板里有一个「重打 asar 并部署」条目显示已运行 57 分钟。
 * 实际核查：该任务的底层进程早已被 TaskStop 杀掉，UI 只是没刷新——属**僵尸任务条目**。
 * 用户要求：「后续每次结束的时候都检测 30 分钟以上的后台任务是否正常，是否无效进程，
 * 无效进程需要清理」。
 *
 * 本脚本做三件事：
 *   1. 列出当前存活的相关进程（node / makensis / DeepSeekAgent.exe / 7z），含启动时间与命令行；
 *   2. 标出「疑似无效」进程：本项目相关的长驻进程（pack/smoke/e2e/dsh web 等）超过阈值仍在跑；
 *   3. --kill-stale 时清理判定为无效的进程（默认只报告，不杀）。
 *
 * 判定「无效」的规则（保守）：
 *   - 属于本项目脚本（命令行含 apps/agent-client 或 dsh-harness 特征）；
 *   - 运行时长 > --max-min（默认 30 分钟）；
 *   - 且不是明确的长期任务（如 `_e2e_installer` 大目录清理可能在合法慢跑 → 用 --allow 白名单）。
 *
 * 用法：
 *   node scripts/_check_stale_tasks.mjs                    # 只报告
 *   node scripts/_check_stale_tasks.mjs --kill-stale       # 报告并清理
 *   node scripts/_check_stale_tasks.mjs --max-min 20       # 自定义阈值
 */
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const KILL = argv.includes('--kill-stale');
const mi = argv.indexOf('--max-min');
const MAX_MIN = mi >= 0 && argv[mi + 1] ? Number(argv[mi + 1]) : 30;

// 本项目相关进程特征（命令行匹配）
const PROJECT_MARKERS = [
  'apps/agent-client', 'apps\\agent-client',
  'deepseek-harness', 'D:\\DeepSeekAgent', 'D:/DeepSeekAgent',
  '_e2e_installer', '_smoke_after_junction', 'pack-app-asar', '_patch-app-asar',
  'makensis', 'bin\\bin.js', 'dsh-runtime',
  '_stage\\fast-clean', '_stage/fast-clean', 'fast-clean.ps1',
];

/** 允许长时间合法运行的例外（命令行子串）：清理大目录这类操作本身就很慢。 */
const ALLOW_LONG = [
  'fs.rmSync', 'rmSync',           // 大目录清理
  '_e2e_installer',                // E2E 全流程（火绒下可能 >30min）
  'cleanup',                       // 显式清理任务
];

// 2026-09-18 修正：原 Name 过滤器只匹配 `node|makensis|7z|DeepSeekAgent`，
// **漏掉了 powershell.exe**。而本仓库的大目录清理一律走 PowerShell
// （`_stage\fast-clean.ps1`，因为 fs.rmSync 在火绒下极慢、[System.IO.*] 才可用），
// 结果清理任务跑到 37 分钟仍被判定「无本项目相关存活进程」——自检形同虚设。
// 现把 powershell / pwsh / cmd 一并纳入候选，再靠 PROJECT_MARKERS 收窄到本项目。
function psList() {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|makensis|7z|DeepSeekAgent|powershell|pwsh' } | ` +
    `Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Depth 3 -Compress`,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return [];
  try {
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}

function minutesSince(cimDate) {
  if (!cimDate) return null;
  // CIM 日期形如 /Date(1758...)/ 或 ISO
  let ms = null;
  const m = /\/Date\((\d+)\)\//.exec(String(cimDate));
  if (m) ms = Number(m[1]);
  else { const t = Date.parse(cimDate); if (!Number.isNaN(t)) ms = t; }
  if (ms == null) return null;
  return (Date.now() - ms) / 60000;
}

const procs = psList();
const rows = [];
for (const p of procs) {
  const cmd = String(p.CommandLine || '');
  const isProject = PROJECT_MARKERS.some((mk) => cmd.includes(mk));
  if (!isProject) continue;
  const mins = minutesSince(p.CreationDate);
  const allow = ALLOW_LONG.some((mk) => cmd.includes(mk));
  const stale = mins != null && mins > MAX_MIN && !allow;
  rows.push({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    mins: mins == null ? '?' : mins.toFixed(1),
    allow,
    stale,
    cmd: cmd.replace(/\s+/g, ' ').slice(0, 150),
  });
}

console.log(`=== 后台任务收尾自检 (阈值 ${MAX_MIN} 分钟) — ${new Date().toLocaleString()} ===`);
if (rows.length === 0) {
  console.log('  无本项目相关存活进程。');
} else {
  for (const r of rows) {
    const tag = r.stale ? '⚠️ STALE' : (r.allow ? '⏳ 合法慢任务' : '✓ 正常');
    console.log(`  [${tag}] pid=${r.pid} ppid=${r.ppid} ${r.name} 运行 ${r.mins}min`);
    console.log(`         ${r.cmd}`);
  }
}

const staleRows = rows.filter((r) => r.stale);
if (staleRows.length === 0) {
  console.log('结论: 无超过阈值的无效进程。');
} else {
  console.log(`结论: 发现 ${staleRows.length} 个疑似无效进程（>${MAX_MIN}min）。`);
  if (KILL) {
    for (const r of staleRows) {
      const k = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Stop-Process -Id ${r.pid} -Force -ErrorAction SilentlyContinue; ` +
        `if (Get-Process -Id ${r.pid} -ErrorAction SilentlyContinue) { 'STILL' } else { 'KILLED' }`,
      ], { encoding: 'utf8', windowsHide: true });
      console.log(`  清理 pid=${r.pid}: ${(k.stdout || '').trim() || 'done'}`);
    }
  } else {
    console.log('（未清理；加 --kill-stale 执行清理）');
  }
}
