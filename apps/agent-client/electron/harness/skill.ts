/**
 * Skill 技能系统运行时。
 *
 * 遵循 deepseek-harness 设计原则：
 * - 服务化：SkillRuntime 作为 Service 注册到 Context
 * - 事件驱动：技能变更通过事件通知
 * - 动态扩展：技能可动态注册/启用/禁用
 * - 前馈模式：已启用技能的指令在模型调用前注入系统提示
 *
 * 技能 = 可复用的专家指令 + 示例，运行时注入系统提示，
 * 让模型按特定方法论回答问题。
 */

import type { Context } from './context.js'
import { Service } from './context.js'

// ============================================================
// 类型定义
// ============================================================

/** 技能定义 */
export interface Skill {
  /** 技能唯一 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 简介 */
  description: string
  /** 注入系统提示的核心指令 */
  instructions: string
  /** 少样本示例（可选） */
  examples?: Array<{ input: string; output: string }>
  /** 是否启用 */
  enabled: boolean
  /** 是否为内置技能 */
  builtin?: boolean
  /** 技能分类（用于分组展示） */
  category?: string
  /** 优先级（数字越小越先注入） */
  priority?: number
}

// ============================================================
// 内置技能
// ============================================================

const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'skill-planning',
    name: '任务规划',
    description: '先拆解步骤再执行，提升复杂任务的首次正确率。',
    instructions:
      '面对复杂任务时，先输出一份简明计划（3-7 步），标注每步目标与依赖，然后再逐步执行。' +
      '若用户明确要求直接给结果，可跳过计划直接回答。',
    enabled: false,
    builtin: true,
    category: 'workflow',
    priority: 10,
  },
  {
    id: 'skill-code-review',
    name: '代码审查',
    description: '按规范审查代码，指出缺陷、风险与改进建议。',
    instructions:
      '审查代码时按以下维度输出：1) 正确性（逻辑/边界/异常）；2) 安全性（注入/越权/敏感信息）；' +
      '3) 性能（复杂度/重复计算）；4) 可维护性（命名/重复/耦合）。每条给出位置、问题、建议修改。',
    enabled: false,
    builtin: true,
    category: 'code',
    priority: 20,
  },
  {
    id: 'skill-selfcheck',
    name: '自我校验',
    description: '回答后自检事实性与完整性，必要时自我纠正。',
    instructions:
      '给出答案后，追加一段自检：检查是否有未验证的事实、是否遗漏用户需求点、是否存在逻辑跳跃。' +
      '若发现问题，直接给出修正后的结论，不要保留错误版本。',
    enabled: false,
    builtin: true,
    category: 'quality',
    priority: 30,
  },
  {
    id: 'skill-structured-output',
    name: '结构化输出',
    description: '用标题、列表、表格组织回答，便于阅读与后续处理。',
    instructions:
      '优先使用结构化格式：多级标题、要点列表、对比表格。技术内容附代码片段并标注语言。' +
      '结论先行，细节后置。',
    enabled: false,
    builtin: true,
    category: 'presentation',
    priority: 40,
  },
]

// ============================================================
// 上下文类型声明合并
// ============================================================

declare module './context.js' {
  interface Context {
    skill: SkillRuntime
  }
}

// ============================================================
// SkillRuntime 服务
// ============================================================

/**
 * 技能运行时服务。
 *
 * 负责：
 * - 管理技能目录（内置 + 自定义）
 * - 技能的增删改查
 * - 技能启用/禁用
 * - 生成技能提示（注入系统提示）
 */
export class SkillRuntime extends Service {
  private skills = new Map<string, Skill>()
  private storagePath: string | null = null

  constructor(ctx: Context) {
    super(ctx, 'skill')

    // 声明事件
    ctx.declareEvent('skill/added', 'emit')
    ctx.declareEvent('skill/removed', 'emit')
    ctx.declareEvent('skill/updated', 'emit')
    ctx.declareEvent('skill/enabled', 'emit')
    ctx.declareEvent('skill/disabled', 'emit')

    // 加载内置技能
    this.loadBuiltinSkills()
  }

  // ========== 内置技能 ==========

  /**
   * 加载内置技能。
   */
  private loadBuiltinSkills(): void {
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, { ...skill })
    }
  }

  // ========== 技能管理 ==========

  /**
   * 添加技能。
   */
  addSkill(skill: Omit<Skill, 'builtin'> & { builtin?: boolean }): Skill {
    if (this.skills.has(skill.id)) {
      throw new Error(`skill "${skill.id}" already exists`)
    }

    const fullSkill: Skill = {
      ...skill,
      builtin: skill.builtin ?? false,
      priority: skill.priority ?? 100,
    }

    this.skills.set(skill.id, fullSkill)
    this.ctx.emit('skill/added', fullSkill)

    if (skill.enabled) {
      this.ctx.emit('skill/enabled', skill.id)
    }

    return fullSkill
  }

  /**
   * 移除技能。
   * 内置技能不可移除。
   */
  removeSkill(id: string): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false
    if (skill.builtin) {
      throw new Error(`cannot remove builtin skill "${id}"`)
    }

    const wasEnabled = skill.enabled
    this.skills.delete(id)
    this.ctx.emit('skill/removed', id)

    if (wasEnabled) {
      this.ctx.emit('skill/disabled', id)
    }

    return true
  }

  /**
   * 更新技能。
   */
  updateSkill(id: string, updates: Partial<Skill>): Skill | undefined {
    const skill = this.skills.get(id)
    if (!skill) return undefined

    const wasEnabled = skill.enabled
    const updated: Skill = { ...skill, ...updates, id }
    this.skills.set(id, updated)

    this.ctx.emit('skill/updated', updated)

    // 启用状态变化
    if (updates.enabled !== undefined && updates.enabled !== wasEnabled) {
      if (updates.enabled) {
        this.ctx.emit('skill/enabled', id)
      } else {
        this.ctx.emit('skill/disabled', id)
      }
    }

    return updated
  }

  /**
   * 获取技能。
   */
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  /**
   * 列出所有技能。
   * 按优先级排序。
   */
  listSkills(): Skill[] {
    return [...this.skills.values()].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
  }

  /**
   * 列出已启用的技能。
   */
  listActiveSkills(): Skill[] {
    return this.listSkills().filter((s) => s.enabled)
  }

  /**
   * 按分类列出技能。
   */
  listByCategory(): Record<string, Skill[]> {
    const result: Record<string, Skill[]> = {}
    for (const skill of this.listSkills()) {
      const cat = skill.category || 'other'
      if (!result[cat]) result[cat] = []
      result[cat].push(skill)
    }
    return result
  }

  // ========== 启用/禁用 ==========

  /**
   * 启用技能。
   */
  enableSkill(id: string): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false
    if (skill.enabled) return true

    skill.enabled = true
    this.ctx.emit('skill/enabled', id)
    this.ctx.emit('skill/updated', skill)
    return true
  }

  /**
   * 禁用技能。
   */
  disableSkill(id: string): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false
    if (!skill.enabled) return true

    skill.enabled = false
    this.ctx.emit('skill/disabled', id)
    this.ctx.emit('skill/updated', skill)
    return true
  }

  /**
   * 切换技能启用状态。
   */
  toggleSkill(id: string): boolean {
    const skill = this.skills.get(id)
    if (!skill) return false

    if (skill.enabled) {
      this.disableSkill(id)
      return false
    } else {
      this.enableSkill(id)
      return true
    }
  }

  // ========== 提示生成 ==========

  /**
   * 生成技能提示片段。
   * 将所有已启用技能的指令编译成系统提示片段。
   *
   * 这是「前馈」的一环：在模型作答前把方法论注入上下文，提高首次正确率。
   */
  buildPrompt(): string {
    const actives = this.listActiveSkills()
    if (actives.length === 0) return ''

    const blocks = actives.map((s) => {
      let block = `### 技能：${s.name}\n${s.instructions}`
      if (s.examples?.length) {
        block += '\n\n示例：'
        s.examples.forEach((ex) => {
          block += `\n- 输入：${ex.input}\n  输出：${ex.output}`
        })
      }
      return block
    })

    return `你已启用以下技能，请严格按其方法论作答：\n\n${blocks.join('\n\n')}`
  }

  // ========== 持久化 ==========

  /**
   * 从 JSON 数据加载技能（自定义技能）。
   * 内置技能保持不变，用户配置的覆盖内置的启用状态。
   */
  loadFromJSON(data: Skill[]): void {
    for (const saved of data) {
      const existing = this.skills.get(saved.id)
      if (existing && existing.builtin) {
        // 内置技能：只更新启用状态
        if (saved.enabled !== undefined) {
          this.updateSkill(saved.id, { enabled: saved.enabled })
        }
      } else {
        // 自定义技能：添加或更新
        if (existing) {
          this.updateSkill(saved.id, saved)
        } else {
          this.addSkill(saved)
        }
      }
    }
  }

  /**
   * 导出所有技能为 JSON（用于持久化）。
   */
  toJSON(): Skill[] {
    return this.listSkills()
  }

  // ========== 统计 ==========

  /**
   * 获取技能统计。
   */
  getStats(): {
    total: number
    enabled: number
    builtin: number
    custom: number
    categories: string[]
  } {
    const skills = this.listSkills()
    const categories = new Set(skills.map((s) => s.category || 'other'))
    return {
      total: skills.length,
      enabled: skills.filter((s) => s.enabled).length,
      builtin: skills.filter((s) => s.builtin).length,
      custom: skills.filter((s) => !s.builtin).length,
      categories: [...categories],
    }
  }
}
