/**
 * 从 desktop/runtime-dist 的 dsh-llm-deepseek 中移除 DashScope/qwen 默认模型目录。
 * 目的：runtime-dist 是 electron-builder extraResources 的运行时来源，
 *      若不同步该修复，每次重建安装包都会把阿里云 qwen 模型带回来（用户明确禁止）。
 * 幂等：已无 qwen 条目时直接跳过。
 */
import fs from 'node:fs';

const FILE = 'D:/WorkSpace/deepseek-harness-master/desktop/runtime-dist/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js';
const SENTINEL = '// DashScope（OpenAI 兼容模式）常见模型';

let src = fs.readFileSync(FILE, 'utf8');
if (!src.includes('qwen3.6-plus') && !src.includes(SENTINEL)) {
  console.log('已是干净状态（无 qwen 默认模型），跳过');
  process.exit(0);
}

const lines = src.split('\n');
const start = lines.findIndex((l) => l.includes(SENTINEL));
if (start < 0) { console.error('未找到 qwen 目录起始注释行'); process.exit(2); }
// 结束行：从 start 起第一条 "];" （DEFAULT_MODELS 数组结束）
let end = -1;
for (let i = start; i < lines.length; i++) {
  if (lines[i].trim() === '];') { end = i; break; }
}
if (end < 0) { console.error('未找到 DEFAULT_MODELS 结束行'); process.exit(2); }

const removed = lines.slice(start, end);
console.log('将删除行区间', start + 1, '..', end, '（' + removed.length + ' 行）');
console.log('首行:', removed[0].trim());
console.log('末行:', removed[removed.length - 1].trim());

const out = [...lines.slice(0, start), ...lines.slice(end)];
// 去掉 vision-exp 条目后可能留下的尾逗号问题：这里保留 "]," 结构不变，仅确认数组结束
const text = out.join('\n');
if (!/DEFAULT_MODELS = \[[\s\S]*?\n\];/.test(text)) { console.error('结构校验失败，未写入'); process.exit(3); }

fs.copyFileSync(FILE, FILE + '.qwen-bak');
fs.writeFileSync(FILE, text, 'utf8');
console.log('已写入；备份:', FILE + '.qwen-bak');
console.log('剩余 qwen 引用:', (text.match(/qwen/gi) || []).length);
src = text;
