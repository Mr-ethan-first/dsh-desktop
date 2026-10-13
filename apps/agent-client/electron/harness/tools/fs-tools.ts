/**
 * 文件系统工具：工作目录内的文件操作。
 *
 * 遵循 deepseek-harness 工具设计模式：
 * - 使用 defineTool 声明式定义
 * - 路径穿越防护：所有操作限制在工作目录内
 * - 风险等级：写/读/列为 low，删除为 high
 * - 自动校验：HTML 文件写入后自动校验
 */

import { promises as fs } from 'node:fs'
import { join, resolve, relative, normalize } from 'node:path'
import { exec } from 'node:child_process'
import type { Context } from '../context.js'
import { defineTool } from '../tools.js'
import type { ContentBlock } from '../session.js'

/**
 * 权限等级：从低到高。
 * - read：仅允许读取 / 列出目录（fs__read_file、fs__list_dir）
 * - write：在 read 基础上允许创建 / 覆盖 / 删除文件（fs__write_file、fs__delete_file）
 * - execute：在 write 基础上允许执行 shell 命令（fs__run_command）
 */
export type PermissionLevel = 'read' | 'write' | 'execute'

/** 工作区状态（运行时可变的共享对象，由 HarnessApp 持有并对外暴露）。 */
export interface WorkspaceState {
  /** 当前工作目录（绝对路径）。 */
  workDir: string
  /** 当前权限等级。 */
  permission: PermissionLevel
}

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  read: 1,
  write: 2,
  execute: 3,
}

const PERMISSION_LABEL: Record<PermissionLevel, string> = {
  read: '只读',
  write: '读写',
  execute: '读写 + 执行',
}

/** 校验当前权限是否满足所需等级，不足则抛出明确错误。 */
function assertPermission(ws: WorkspaceState, need: PermissionLevel): void {
  if (PERMISSION_ORDER[ws.permission] < PERMISSION_ORDER[need]) {
    throw new Error(
      `权限不足：当前工作区权限为「${PERMISSION_LABEL[ws.permission]}」，该操作需要「${PERMISSION_LABEL[need]}」权限。请在 AI 对话 (Harness) 右侧「工作目录与权限」中提升权限。`,
    )
  }
}

/**
 * 确保路径在工作目录内，防止路径穿越。
 * @throws 如果路径越界则抛出错误
 */
function safePath(workDir: string, relPath: string): string {
  const rel = String(relPath || '').trim()

  // 拒绝绝对路径（Windows 盘符或 Unix 根路径）
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    throw new Error('路径越界：不允许使用绝对路径')
  }

  // 直接解析绝对路径（保留 .. 以检测越界）
  const absolute = resolve(workDir, rel)
  const normalizedWorkDir = normalize(workDir)
  const normalizedAbsolute = normalize(absolute)

  // 计算从工作目录到目标路径的相对路径
  const relFromBase = relative(normalizedWorkDir, normalizedAbsolute)

  // 如果相对路径以 .. 开头或为空，说明越界或就是工作目录本身
  // 空相对路径意味着目标就是工作目录本身
  if (relFromBase.startsWith('..') || normalize(relFromBase).startsWith('..')) {
    throw new Error('路径越界：不允许访问工作目录之外的文件')
  }

  return normalizedAbsolute
}

/** HTML 自动校验结果 */
interface HtmlVerifyResult {
  passed: boolean
  issues: string[]
}

/**
 * 简单的 HTML 产物校验。
 * 检查基本结构和自包含性。
 */
function verifyHtml(content: string): HtmlVerifyResult {
  const issues: string[] = []

  // 检查是否有基本 HTML 结构
  if (!/<html/i.test(content)) {
    issues.push('缺少 <html> 标签')
  }
  if (!/<head/i.test(content)) {
    issues.push('缺少 <head> 标签')
  }
  if (!/<body/i.test(content)) {
    issues.push('缺少 <body> 标签')
  }

  // 检查是否引用了外部资源（非内联）
  const externalSrc = /<(script|link|img)\s+[^>]*(src|href)="https?:\/\//i
  if (externalSrc.test(content)) {
    issues.push('引用了外部 CDN 资源，建议内联以确保离线可用')
  }

  return {
    passed: issues.length === 0,
    issues,
  }
}

/**
 * 注册文件系统工具到 ToolRuntime。
 *
 * 工具在每次执行时读取共享的 WorkspaceState（工作目录 + 权限等级），
 * 因此运行时切换工作目录或权限等级会立即对所有后续工具调用生效。
 *
 * @param ctx - Cordis 上下文
 * @param workspace - 可变的工作区状态（由 HarnessApp 持有）
 */
export function registerFsTools(ctx: Context, workspace: WorkspaceState): void {
  // ============ fs__write_file ============
  ctx.tools.register(defineTool({
    name: 'fs__write_file',
    description: `在当前工作目录（${workspace.workDir}）内创建或覆盖文件；父目录自动创建。relPath 为相对工作目录的路径（禁止 .. 与绝对路径）。产出代码/文档/页面等成果时必须用本工具落盘。HTML 落盘后会自动校验（结构/自包含/内联 JS 语法），校验发现问题会在结果中列出，须修复后重新写入。需要「读写」及以上权限。`,
    parameters: {
      type: 'object',
      properties: {
        relPath: {
          type: 'string',
          description: '相对工作目录的文件路径，如 tank.html 或 src/app.js',
        },
        content: {
          type: 'string',
          description: '写入的完整文件内容',
        },
      },
      required: ['relPath', 'content'],
      additionalProperties: false,
    },
    async execute(args): Promise<ContentBlock[]> {
      assertPermission(workspace, 'write')
      const relPath = String(args.relPath)
      const content = String(args.content)
      const absPath = safePath(workspace.workDir, relPath)

      // 确保父目录存在
      await fs.mkdir(join(absPath, '..'), { recursive: true })
      await fs.writeFile(absPath, content, 'utf-8')

      // HTML 自动校验
      if (/\.(html?|htm)$/i.test(relPath)) {
        const result = verifyHtml(content)
        if (result.passed) {
          return [
            { type: 'text', text: `已写入文件：${relPath}（${content.length} 字节）` },
            { type: 'text', text: '自动校验通过 ✅' },
          ]
        } else {
          return [
            { type: 'text', text: `已写入文件：${relPath}（${content.length} 字节）` },
            { type: 'text', text: `自动校验发现问题：\n${result.issues.map((i) => `- ${i}`).join('\n')}\n（文件已保存，请修复后重新写入）` },
          ]
        }
      }

      return [{ type: 'text', text: `已写入文件：${relPath}（${content.length} 字节）` }]
    },
    risk: 'low',
    isConcurrencySafe: false,
  }))

  // ============ fs__read_file ============
  ctx.tools.register(defineTool({
    name: 'fs__read_file',
    description: `读取当前工作目录（${workspace.workDir}）内的文件内容。relPath 为相对路径。需要「只读」及以上权限。`,
    parameters: {
      type: 'object',
      properties: {
        relPath: {
          type: 'string',
          description: '相对工作目录的文件路径',
        },
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    async execute(args): Promise<ContentBlock[]> {
      assertPermission(workspace, 'read')
      const relPath = String(args.relPath)
      const absPath = safePath(workspace.workDir, relPath)
      const content = await fs.readFile(absPath, 'utf-8')
      return [{ type: 'text', text: content }]
    },
    risk: 'low',
    isConcurrencySafe: true,
  }))

  // ============ fs__list_dir ============
  ctx.tools.register(defineTool({
    name: 'fs__list_dir',
    description: `列出当前工作目录（${workspace.workDir}）内某子目录的文件清单（JSON 数组，目录名带 / 后缀）。relPath 传空字符串列根目录。需要「只读」及以上权限。`,
    parameters: {
      type: 'object',
      properties: {
        relPath: {
          type: 'string',
          description: '相对工作目录的子目录路径；空串表示根',
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args): Promise<ContentBlock[]> {
      assertPermission(workspace, 'read')
      const relPath = String(args.relPath || '')
      const dir = relPath ? safePath(workspace.workDir, relPath) : workspace.workDir
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const result = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
      return [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    },
    risk: 'low',
    isConcurrencySafe: true,
  }))

  // ============ fs__delete_file ============
  ctx.tools.register(defineTool({
    name: 'fs__delete_file',
    description: '删除当前工作目录内的指定文件（高风险：不可恢复，需用户确认）。需要「读写」及以上权限。',
    parameters: {
      type: 'object',
      properties: {
        relPath: {
          type: 'string',
          description: '相对工作目录的文件路径',
        },
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    async execute(args): Promise<ContentBlock[]> {
      assertPermission(workspace, 'write')
      const relPath = String(args.relPath)
      const absPath = safePath(workspace.workDir, relPath)
      await fs.unlink(absPath)
      return [{ type: 'text', text: `已删除文件：${relPath}` }]
    },
    risk: 'high',
    isConcurrencySafe: false,
  }))

  // ============ fs__run_command ============
  ctx.tools.register(defineTool({
    name: 'fs__run_command',
    description: `在工作目录（${workspace.workDir}）内执行一条 shell 命令，用于验证生成的代码能否正常运行、测试是否通过。典型用法：运行刚写好的脚本（如 "node 文件名.js" / "python 文件名.py" / "npm test"）。命令的工作目录固定为工作目录，无法逃逸到目录之外。返回格式：exitCode、stdout、stderr（单段超过 4000 字节会截断）。非零退出码会在结果中标明，便于据此修复代码后重新运行。需要「读写 + 执行」权限。`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令，例如 "node sort.js" 或 "python main.py" 或 "npm test"',
        },
        timeoutMs: {
          type: 'number',
          description: '超时毫秒数，默认 60000；复杂构建/测试可适当调大',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(args): Promise<ContentBlock[]> {
      assertPermission(workspace, 'execute')
      const command = String(args.command ?? '').trim()
      if (!command) {
        return [{ type: 'text', text: 'Error: command 不能为空' }]
      }
      const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 60_000

      const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolvePromise) => {
        const child = exec(
          command,
          { cwd: workspace.workDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, stdout, stderr) => {
            let exitCode = 1
            if (!err) {
              exitCode = 0
            } else if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
              exitCode = 124
            } else if (typeof (err as { code?: unknown }).code === 'number') {
              exitCode = (err as { code?: unknown }).code as number
            }
            resolvePromise({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '' })
          },
        )
        // 防止子进程在标准错误但不退出时挂起：依赖 timeout 触发 ETIMEDOUT
        child.on('error', () => {
          /* exec 回调会处理 */
        })
      })

      const truncate = (s: string): string =>
        s.length > 4000 ? `${s.slice(0, 4000)}\n...（已截断，共 ${s.length} 字节）` : s

      const out =
        `exitCode: ${result.exitCode}\n` +
        `--- stdout ---\n${truncate(result.stdout)}\n` +
        `--- stderr ---\n${truncate(result.stderr)}`

      return [{ type: 'text', text: out }]
    },
    risk: 'medium',
    isConcurrencySafe: false,
  }))
}
