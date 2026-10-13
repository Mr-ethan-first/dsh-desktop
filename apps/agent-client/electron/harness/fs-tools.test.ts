/**
 * 文件系统工具单元测试。
 *
 * 测试路径安全、文件读写操作。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from './context'
import { ToolRuntime } from './tools'
import { registerFsTools, type WorkspaceState } from './tools/fs-tools'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

describe('FS Tools', () => {
  let ctx: Context
  let tools: ToolRuntime
  let workDir: string

  beforeEach(async () => {
    // 创建临时工作目录
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-tools-test-'))

    ctx = new Context()
    ctx.plugin(ToolRuntime as any)
    tools = (ctx as any).tools as ToolRuntime
    // registerFsTools 接收可变的 WorkspaceState（工作目录 + 权限等级）；
    // 测试默认授予「读写 + 执行」以覆盖写文件与运行命令的用例。
    const ws: WorkspaceState = { workDir, permission: 'execute' }
    registerFsTools(ctx, ws)
  })

  afterEach(async () => {
    // 清理临时目录
    try {
      await fs.rm(workDir, { recursive: true, force: true })
    } catch {
      // 忽略清理错误
    }
  })

  describe('fs__write_file', () => {
    it('writes a file to the work directory', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: 'test.txt', content: 'hello world' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      const written = await fs.readFile(path.join(workDir, 'test.txt'), 'utf-8')
      expect(written).toBe('hello world')
    })

    it('creates parent directories automatically', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: 'a/b/c/test.txt', content: 'nested' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      const exists = await fs.access(path.join(workDir, 'a', 'b', 'c', 'test.txt')).then(() => true).catch(() => false)
      expect(exists).toBe(true)
    })

    it('rejects path traversal with ..', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: '../outside.txt', content: 'hacked' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
      expect((result.content[0] as any).text).toContain('越界')
    })

    it('rejects absolute paths', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: '/etc/passwd', content: 'hacked' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })

    it('rejects deep path traversal', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: 'a/../../outside.txt', content: 'hacked' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('fs__read_file', () => {
    it('reads an existing file', async () => {
      await fs.writeFile(path.join(workDir, 'readme.txt'), 'read me content', 'utf-8')

      const result = await tools.execute(
        'fs__read_file',
        { relPath: 'readme.txt' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      expect((result.content[0] as any).text).toContain('read me content')
    })

    it('returns error for non-existent file', async () => {
      const result = await tools.execute(
        'fs__read_file',
        { relPath: 'nonexistent.txt' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })

    it('rejects path traversal', async () => {
      const result = await tools.execute(
        'fs__read_file',
        { relPath: '../secret.txt' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('fs__list_dir', () => {
    it('lists directory contents', async () => {
      await fs.writeFile(path.join(workDir, 'file1.txt'), '1', 'utf-8')
      await fs.writeFile(path.join(workDir, 'file2.txt'), '2', 'utf-8')
      await fs.mkdir(path.join(workDir, 'subdir'))

      const result = await tools.execute(
        'fs__list_dir',
        { relPath: '.' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      const text = (result.content[0] as any).text
      expect(text).toContain('file1.txt')
      expect(text).toContain('file2.txt')
      expect(text).toContain('subdir')
    })

    it('lists subdirectory', async () => {
      await fs.mkdir(path.join(workDir, 'sub'))
      await fs.writeFile(path.join(workDir, 'sub', 'inner.txt'), 'inner', 'utf-8')

      const result = await tools.execute(
        'fs__list_dir',
        { relPath: 'sub' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      const text = (result.content[0] as any).text
      expect(text).toContain('inner.txt')
    })

    it('rejects path traversal', async () => {
      const result = await tools.execute(
        'fs__list_dir',
        { relPath: '..' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('fs__delete_file', () => {
    it('deletes a file', async () => {
      await fs.writeFile(path.join(workDir, 'todelete.txt'), 'delete me', 'utf-8')

      const result = await tools.execute(
        'fs__delete_file',
        { relPath: 'todelete.txt' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(false)
      const exists = await fs.access(path.join(workDir, 'todelete.txt')).then(() => true).catch(() => false)
      expect(exists).toBe(false)
    })

    it('rejects path traversal', async () => {
      const result = await tools.execute(
        'fs__delete_file',
        { relPath: '../important.txt' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })

    it('rejects directory deletion', async () => {
      await fs.mkdir(path.join(workDir, 'mydir'))

      const result = await tools.execute(
        'fs__delete_file',
        { relPath: 'mydir' },
        { agentId: 'test' },
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('HTML validation', () => {
    it('validates HTML files on write', async () => {
      const result = await tools.execute(
        'fs__write_file',
        { relPath: 'index.html', content: '<html><body><p>valid</p></body></html>' },
        { agentId: 'test' },
      )

      // 应该成功写入，HTML 验证通过
      expect(result.isError).toBe(false)
    })

    it('reports HTML validation warnings', async () => {
      // 未闭合标签
      const result = await tools.execute(
        'fs__write_file',
        { relPath: 'bad.html', content: '<html><body><p>unclosed' },
        { agentId: 'test' },
      )

      // 仍然写入成功，但应该有警告（在第二个 content block 中）
      expect(result.isError).toBe(false)
      expect(result.content.length).toBeGreaterThan(1)
      const allText = result.content.map((c: any) => c.text).join('\n')
      expect(allText).toContain('校验')
      expect(allText).toContain('问题')
    })
  })
})
