/**
 * SkillRuntime 单元测试。
 *
 * 测试技能系统的核心功能：
 * - 技能管理（添加、移除、更新）
 * - 启用/禁用
 * - 提示生成
 * - 分类和排序
 * - 事件系统
 * - 持久化
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Context } from './context'
import { SkillRuntime } from './skill'

describe('SkillRuntime', () => {
  let ctx: Context
  let skill: SkillRuntime

  beforeEach(() => {
    ctx = new Context()
    ctx.plugin(SkillRuntime as any)
    skill = (ctx as any).skill as SkillRuntime
  })

  describe('内置技能', () => {
    it('默认加载 4 个内置技能', () => {
      const skills = skill.listSkills()
      expect(skills.length).toBe(4)
    })

    it('内置技能标记为 builtin', () => {
      const skills = skill.listSkills()
      skills.forEach((s) => {
        expect(s.builtin).toBe(true)
      })
    })

    it('内置技能默认禁用', () => {
      const skills = skill.listSkills()
      skills.forEach((s) => {
        expect(s.enabled).toBe(false)
      })
    })

    it('包含所有预期的内置技能', () => {
      const ids = skill.listSkills().map((s) => s.id)
      expect(ids).toContain('skill-planning')
      expect(ids).toContain('skill-code-review')
      expect(ids).toContain('skill-selfcheck')
      expect(ids).toContain('skill-structured-output')
    })
  })

  describe('技能管理', () => {
    it('添加自定义技能', () => {
      const newSkill = skill.addSkill({
        id: 'custom-skill',
        name: '自定义技能',
        description: '测试自定义技能',
        instructions: '这是自定义技能的指令',
        enabled: false,
      })

      expect(newSkill.id).toBe('custom-skill')
      expect(newSkill.builtin).toBe(false)
      expect(skill.listSkills().length).toBe(5)
    })

    it('重复添加技能会报错', () => {
      skill.addSkill({
        id: 'custom-skill',
        name: '自定义技能',
        description: '测试',
        instructions: '测试',
        enabled: false,
      })

      expect(() =>
        skill.addSkill({
          id: 'custom-skill',
          name: '重复技能',
          description: '重复',
          instructions: '重复',
          enabled: false,
        }),
      ).toThrow('already exists')
    })

    it('移除自定义技能', () => {
      skill.addSkill({
        id: 'custom-skill',
        name: '自定义技能',
        description: '测试',
        instructions: '测试',
        enabled: false,
      })

      const result = skill.removeSkill('custom-skill')
      expect(result).toBe(true)
      expect(skill.listSkills().length).toBe(4)
    })

    it('不能移除内置技能', () => {
      expect(() => skill.removeSkill('skill-planning')).toThrow('cannot remove builtin')
    })

    it('移除不存在的技能返回 false', () => {
      const result = skill.removeSkill('non-existent')
      expect(result).toBe(false)
    })

    it('更新技能', () => {
      const updated = skill.updateSkill('skill-planning', {
        name: '新名称',
        description: '新描述',
      })

      expect(updated).toBeDefined()
      expect(updated?.name).toBe('新名称')
      expect(updated?.description).toBe('新描述')
    })

    it('更新不存在的技能返回 undefined', () => {
      const result = skill.updateSkill('non-existent', { name: 'test' })
      expect(result).toBeUndefined()
    })

    it('获取技能', () => {
      const s = skill.getSkill('skill-planning')
      expect(s).toBeDefined()
      expect(s?.id).toBe('skill-planning')
    })

    it('获取不存在的技能返回 undefined', () => {
      const s = skill.getSkill('non-existent')
      expect(s).toBeUndefined()
    })
  })

  describe('启用/禁用', () => {
    it('启用技能', () => {
      const result = skill.enableSkill('skill-planning')
      expect(result).toBe(true)

      const s = skill.getSkill('skill-planning')
      expect(s?.enabled).toBe(true)
    })

    it('禁用技能', () => {
      skill.enableSkill('skill-planning')
      const result = skill.disableSkill('skill-planning')
      expect(result).toBe(true)

      const s = skill.getSkill('skill-planning')
      expect(s?.enabled).toBe(false)
    })

    it('切换技能', () => {
      // 初始禁用
      expect(skill.getSkill('skill-planning')?.enabled).toBe(false)

      // 切换为启用
      let result = skill.toggleSkill('skill-planning')
      expect(result).toBe(true)
      expect(skill.getSkill('skill-planning')?.enabled).toBe(true)

      // 切换为禁用
      result = skill.toggleSkill('skill-planning')
      expect(result).toBe(false)
      expect(skill.getSkill('skill-planning')?.enabled).toBe(false)
    })

    it('启用不存在的技能返回 false', () => {
      const result = skill.enableSkill('non-existent')
      expect(result).toBe(false)
    })

    it('禁用不存在的技能返回 false', () => {
      const result = skill.disableSkill('non-existent')
      expect(result).toBe(false)
    })
  })

  describe('列表和查询', () => {
    it('listActiveSkills 只返回已启用的技能', () => {
      expect(skill.listActiveSkills().length).toBe(0)

      skill.enableSkill('skill-planning')
      expect(skill.listActiveSkills().length).toBe(1)
      expect(skill.listActiveSkills()[0].id).toBe('skill-planning')

      skill.enableSkill('skill-selfcheck')
      expect(skill.listActiveSkills().length).toBe(2)
    })

    it('技能按优先级排序', () => {
      const skills = skill.listSkills()
      for (let i = 1; i < skills.length; i++) {
        const prev = skills[i - 1].priority ?? 100
        const curr = skills[i].priority ?? 100
        expect(prev).toBeLessThanOrEqual(curr)
      }
    })

    it('listByCategory 按分类分组', () => {
      const byCategory = skill.listByCategory()
      expect(byCategory['workflow']).toBeDefined()
      expect(byCategory['code']).toBeDefined()
      expect(byCategory['quality']).toBeDefined()
      expect(byCategory['presentation']).toBeDefined()
    })
  })

  describe('提示生成', () => {
    it('没有启用技能时返回空字符串', () => {
      const prompt = skill.buildPrompt()
      expect(prompt).toBe('')
    })

    it('启用技能后生成提示', () => {
      skill.enableSkill('skill-planning')
      const prompt = skill.buildPrompt()

      expect(prompt).not.toBe('')
      expect(prompt).toContain('技能：任务规划')
      expect(prompt).toContain('先输出一份简明计划')
    })

    it('多个技能提示按顺序组合', () => {
      skill.enableSkill('skill-planning')
      skill.enableSkill('skill-selfcheck')

      const prompt = skill.buildPrompt()
      expect(prompt).toContain('技能：任务规划')
      expect(prompt).toContain('技能：自我校验')
    })

    it('包含示例的技能提示', () => {
      skill.addSkill({
        id: 'example-skill',
        name: '示例技能',
        description: '带示例的技能',
        instructions: '技能指令',
        enabled: true,
        examples: [
          { input: '输入1', output: '输出1' },
          { input: '输入2', output: '输出2' },
        ],
      })

      const prompt = skill.buildPrompt()
      expect(prompt).toContain('示例：')
      expect(prompt).toContain('输入1')
      expect(prompt).toContain('输出1')
      expect(prompt).toContain('输入2')
      expect(prompt).toContain('输出2')
    })
  })

  describe('事件', () => {
    it('添加技能时触发 skill/added 事件', () => {
      const handler = vi.fn()
      ctx.on('skill/added', handler)

      skill.addSkill({
        id: 'test-skill',
        name: '测试技能',
        description: '测试',
        instructions: '测试',
        enabled: false,
      })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'test-skill' }))
    })

    it('移除技能时触发 skill/removed 事件', () => {
      const handler = vi.fn()

      skill.addSkill({
        id: 'test-skill',
        name: '测试技能',
        description: '测试',
        instructions: '测试',
        enabled: false,
      })

      ctx.on('skill/removed', handler)
      skill.removeSkill('test-skill')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('test-skill')
    })

    it('更新技能时触发 skill/updated 事件', () => {
      const handler = vi.fn()
      ctx.on('skill/updated', handler)

      skill.updateSkill('skill-planning', { name: '新名称' })

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ name: '新名称' }))
    })

    it('启用技能时触发 skill/enabled 事件', () => {
      const handler = vi.fn()
      ctx.on('skill/enabled', handler)

      skill.enableSkill('skill-planning')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('skill-planning')
    })

    it('禁用技能时触发 skill/disabled 事件', () => {
      skill.enableSkill('skill-planning')

      const handler = vi.fn()
      ctx.on('skill/disabled', handler)

      skill.disableSkill('skill-planning')

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith('skill-planning')
    })

    it('添加已启用的技能同时触发 added 和 enabled 事件', () => {
      const addedHandler = vi.fn()
      const enabledHandler = vi.fn()

      ctx.on('skill/added', addedHandler)
      ctx.on('skill/enabled', enabledHandler)

      skill.addSkill({
        id: 'enabled-skill',
        name: '已启用技能',
        description: '测试',
        instructions: '测试',
        enabled: true,
      })

      expect(addedHandler).toHaveBeenCalledTimes(1)
      expect(enabledHandler).toHaveBeenCalledTimes(1)
    })

    it('移除已启用的技能同时触发 removed 和 disabled 事件', () => {
      skill.addSkill({
        id: 'enabled-skill',
        name: '已启用技能',
        description: '测试',
        instructions: '测试',
        enabled: true,
      })

      const removedHandler = vi.fn()
      const disabledHandler = vi.fn()

      ctx.on('skill/removed', removedHandler)
      ctx.on('skill/disabled', disabledHandler)

      skill.removeSkill('enabled-skill')

      expect(removedHandler).toHaveBeenCalledTimes(1)
      expect(disabledHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('持久化', () => {
    it('toJSON 返回所有技能', () => {
      const json = skill.toJSON()
      expect(Array.isArray(json)).toBe(true)
      expect(json.length).toBe(4)
    })

    it('loadFromJSON 加载自定义技能', () => {
      const customSkills = [
        {
          id: 'loaded-skill',
          name: '加载的技能',
          description: '从 JSON 加载',
          instructions: '加载的指令',
          enabled: false,
          builtin: false,
        },
      ]

      skill.loadFromJSON(customSkills)

      expect(skill.listSkills().length).toBe(5)
      expect(skill.getSkill('loaded-skill')).toBeDefined()
    })

    it('loadFromJSON 更新内置技能的启用状态', () => {
      const savedSkills = [
        {
          id: 'skill-planning',
          name: '任务规划',
          description: '原描述',
          instructions: '原指令',
          enabled: true,
          builtin: true,
        },
      ]

      skill.loadFromJSON(savedSkills)

      const s = skill.getSkill('skill-planning')
      expect(s?.enabled).toBe(true)
      // 内置技能的描述和指令不应被覆盖
      expect(s?.description).not.toBe('原描述')
    })

    it('loadFromJSON 更新已存在的自定义技能', () => {
      skill.addSkill({
        id: 'custom-skill',
        name: '旧名称',
        description: '旧描述',
        instructions: '旧指令',
        enabled: false,
      })

      const savedSkills = [
        {
          id: 'custom-skill',
          name: '新名称',
          description: '新描述',
          instructions: '新指令',
          enabled: true,
          builtin: false,
        },
      ]

      skill.loadFromJSON(savedSkills)

      const s = skill.getSkill('custom-skill')
      expect(s?.name).toBe('新名称')
      expect(s?.enabled).toBe(true)
    })
  })

  describe('统计', () => {
    it('getStats 返回正确的统计信息', () => {
      const stats = skill.getStats()

      expect(stats.total).toBe(4)
      expect(stats.enabled).toBe(0)
      expect(stats.builtin).toBe(4)
      expect(stats.custom).toBe(0)
      expect(stats.categories.length).toBeGreaterThan(0)
    })

    it('启用技能后统计更新', () => {
      skill.enableSkill('skill-planning')
      const stats = skill.getStats()

      expect(stats.enabled).toBe(1)
    })

    it('添加自定义技能后统计更新', () => {
      skill.addSkill({
        id: 'custom-skill',
        name: '自定义技能',
        description: '测试',
        instructions: '测试',
        enabled: true,
      })

      const stats = skill.getStats()
      expect(stats.total).toBe(5)
      expect(stats.custom).toBe(1)
      expect(stats.enabled).toBe(1)
    })
  })
})
