/**
 * 轻量级 Cordis 风格的 Context/Service 系统。
 *
 * 遵循 deepseek-harness 的核心设计原则：
 * - 插件式架构：每个功能通过 ctx.plugin() 挂载
 * - 服务注册：Service 类通过继承 Service 基类注册到 ctx
 * - 事件系统：emit / on / waterfall 三种事件模式
 * - 作用域：支持 scoped 上下文（agent-scoped）
 * - 生命周期：effect 管理副作用的自动清理
 *
 * 这是 deepseek-harness Cordis 系统的简化实现，遵循相同的设计思想。
 * 未来可平滑迁移到真正的 @deepseek-ai/cordis 包。
 */

import { randomUUID } from 'node:crypto'

/** 事件模式：emit（单向通知）、waterfall（级联处理）、parallel（并行等待） */
export type EventMode = 'emit' | 'waterfall' | 'parallel'

/** 事件监听器类型 */
export type EventListener = (...args: any[]) => any

/** Effect 清理函数 */
export type Disposer = () => void

/** 服务基类：所有服务都继承此类 */
export abstract class Service {
  constructor(protected ctx: Context, public readonly name: string) {
    // 将服务挂载到 ctx 上
    ;(ctx as any)[name] = this
  }
}

/**
 * 上下文对象：插件系统的核心。
 *
 * 每个插件通过 ctx.plugin() 挂载，服务通过 ctx.serviceName 访问。
 * 事件通过 ctx.on() 订阅，ctx.emit() / ctx.waterfall() 触发。
 */
export class Context {
  /** 已注册的服务 */
  private services = new Map<string, Service>()

  /** 事件监听器：eventName -> listeners[] */
  private eventListeners = new Map<string, EventListener[]>()

  /** 事件模式缓存：eventName -> mode */
  private eventModes = new Map<string, EventMode>()

  /** 活跃的 effect disposers */
  private effects: Disposer[] = []

  /** 父上下文（用于 scope 链） */
  readonly parent: Context | null = null

  /** 上下文 ID */
  readonly id: string

  constructor(parent: Context | null = null) {
    this.id = randomUUID()
    this.parent = parent
  }

  /**
   * 注册一个服务。
   * 服务构造函数会自动将自己挂载到 ctx[name] 上。
   */
  registerService(service: Service): void {
    this.services.set(service.name, service)
  }

  /**
   * 挂载一个插件。
   * 插件是一个接收 ctx 和 config 的函数，在函数内注册服务、监听事件等。
   */
  plugin<T extends new (ctx: Context, config: any) => Service>(
    PluginClass: T,
    config?: ConstructorParameters<T>[1],
  ): void {
    const instance = new PluginClass(this, config ?? {})
    this.registerService(instance)
  }

  /**
   * 声明事件类型（用于类型提示和模式注册）。
   * 实际运行时不强制声明，但建议声明以明确模式。
   */
  declareEvent(name: string, mode: EventMode): void {
    this.eventModes.set(name, mode)
  }

  /**
   * 订阅事件。
   * 返回取消订阅函数。
   */
  on(event: string, listener: EventListener): Disposer {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, [])
    }
    this.eventListeners.get(event)!.push(listener)
    return () => this.off(event, listener)
  }

  /** 取消订阅 */
  off(event: string, listener: EventListener): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    }
  }

  /**
   * 触发 emit 事件（单向通知，不关心返回值）。
   * 监听器失败会被捕获并记录，不会影响其他监听器。
   */
  emit(event: string, ...args: any[]): void {
    const listeners = this.eventListeners.get(event)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener(...args)
      } catch (e) {
        console.error(`[harness] event "${event}" listener error:`, e)
      }
    }
  }

  /**
   * Waterfall 事件：级联处理，每个监听器调用 next() 传递给下一个。
   * 最后一个监听器的 next() 返回默认值。
   *
   * 遵循 Cordis waterfall 语义：不调用 next() 会短路链。
   */
  async waterfall(event: string, args: any[], initialNext: () => Promise<any>): Promise<any> {
    const listeners = this.eventListeners.get(event)
    if (!listeners || listeners.length === 0) {
      return initialNext()
    }

    let index = 0
    const next = async (): Promise<any> => {
      if (index >= listeners.length) {
        return initialNext()
      }
      const listener = listeners[index++]
      return listener(...args, next)
    }
    return next()
  }

  /**
   * Parallel 事件：并行执行所有监听器，等待全部完成。
   */
  async parallel(event: string, ...args: any[]): Promise<void> {
    const listeners = this.eventListeners.get(event)
    if (!listeners) return
    await Promise.all(listeners.map(l => Promise.resolve(l(...args))))
  }

  /**
   * 注册一个 effect：返回清理函数。
   * 上下文销毁时自动清理所有 effect。
   */
  effect(fn: () => Disposer | void, _label?: string): Disposer {
    const disposer = fn()
    if (disposer) {
      this.effects.push(disposer)
    }
    return disposer || (() => {})
  }

  /**
   * 创建子作用域上下文。
   * 子上下文继承父上下文的服务和事件，但有独立的 effect 生命周期。
   */
  extend(overrides: Record<string, unknown> = {}): Context {
    const child = new Context(this)
    // 继承服务引用（不复制，共享实例）
    for (const [name, service] of this.services) {
      ;(child as any)[name] = service
    }
    // 应用覆盖
    for (const [key, value] of Object.entries(overrides)) {
      ;(child as any)[key] = value
    }
    return child
  }

  /**
   * 销毁上下文：清理所有 effect。
   */
  async dispose(): Promise<void> {
    const disposers = [...this.effects].reverse()
    this.effects = []
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (e) {
        console.error('[harness] dispose error:', e)
      }
    }
  }
}
