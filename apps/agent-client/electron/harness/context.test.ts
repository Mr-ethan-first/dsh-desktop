/**
 * Context 模块单元测试。
 *
 * 测试 Cordis 风格的插件系统、事件机制、生命周期管理。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Context, Service } from './context'

// 测试用服务
class TestService extends Service {
  count = 0

  constructor(ctx: Context) {
    super(ctx, 'test')
  }

  increment() {
    this.count++
  }
}

class AnotherService extends Service {
  value = 'hello'

  constructor(ctx: Context) {
    super(ctx, 'another')
  }
}

describe('Context', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  describe('plugin / service registration', () => {
    it('registers a service via plugin()', () => {
      ctx.plugin(TestService as any)
      expect((ctx as any).test).toBeDefined()
      expect((ctx as any).test).toBeInstanceOf(TestService)
    })

    it('accesses service by name', () => {
      ctx.plugin(TestService as any)
      const svc = (ctx as any).test as TestService
      svc.increment()
      expect(svc.count).toBe(1)
    })

    it('registers multiple services', () => {
      ctx.plugin(TestService as any)
      ctx.plugin(AnotherService as any)
      expect((ctx as any).test).toBeDefined()
      expect((ctx as any).another).toBeDefined()
    })
  })

  describe('event system', () => {
    it('emit event triggers listeners', () => {
      let called = 0
      ctx.on('test/event', () => {
        called++
      })
      ctx.emit('test/event')
      expect(called).toBe(1)
    })

    it('emit passes arguments to listeners', () => {
      let received: unknown
      ctx.on('test/event', (arg: string) => {
        received = arg
      })
      ctx.emit('test/event', 'hello')
      expect(received).toBe('hello')
    })

    it('off removes listener', () => {
      let called = 0
      const listener = () => {
        called++
      }
      ctx.on('test/event', listener)
      ctx.off('test/event', listener)
      ctx.emit('test/event')
      expect(called).toBe(0)
    })

    it('disposer from on() removes listener', () => {
      let called = 0
      const dispose = ctx.on('test/event', () => {
        called++
      })
      dispose()
      ctx.emit('test/event')
      expect(called).toBe(0)
    })

    it('multiple listeners all called', () => {
      let count1 = 0
      let count2 = 0
      ctx.on('test/event', () => { count1++ })
      ctx.on('test/event', () => { count2++ })
      ctx.emit('test/event')
      expect(count1).toBe(1)
      expect(count2).toBe(1)
    })

    it('listener error does not affect other listeners', () => {
      let called = 0
      ctx.on('test/event', () => { throw new Error('boom') })
      ctx.on('test/event', () => { called++ })
      ctx.emit('test/event')
      expect(called).toBe(1)
    })
  })

  describe('waterfall events', () => {
    it('waterfall calls next to continue chain', async () => {
      const result = await ctx.waterfall(
        'test/waterfall',
        [],
        async () => 'final',
      )
      expect(result).toBe('final')
    })

    it('waterfall listeners can modify result via next', async () => {
      ctx.on('test/waterfall', (next: () => Promise<string>) => {
        return next().then((r) => r.toUpperCase())
      })
      const result = await ctx.waterfall(
        'test/waterfall',
        [],
        async () => 'hello',
      )
      expect(result).toBe('HELLO')
    })

    it('waterfall supports multiple listeners', async () => {
      ctx.on('test/waterfall', (value: number, next: () => Promise<number>) => {
        return next().then((r) => r + 1)
      })
      ctx.on('test/waterfall', (value: number, next: () => Promise<number>) => {
        return next().then((r) => r * 2)
      })
      const result = await ctx.waterfall(
        'test/waterfall',
        [10],
        async () => 5,
      )
      // 第一个监听器: next() 返回 5 → 5 + 1 = 6
      // 第二个监听器: next() 返回 5 → 5 * 2 = 10
      // 等等，waterfall 是第一个监听器先调用，然后它调用 next() 进入第二个...
      // 不对，waterfall 的顺序是：第一个监听器收到 next，调用 next 进入第二个监听器
      // 所以执行顺序是：
      // listener1 开始 → 调用 next() → listener2 开始 → 调用 next() → initialNext
      // listener2 返回 → listener1 继续处理返回值
      // 所以结果应该是: initial 5 → *2 (listener2) → +1 (listener1) = 11
      expect(result).toBe(11)
    })

    it('waterfall can short-circuit by not calling next', async () => {
      ctx.on('test/waterfall', (_arg, _next: () => Promise<string>) => {
        return 'short-circuited'
      })
      ctx.on('test/waterfall', (_arg, next: () => Promise<string>) => {
        return next() // 不会被调用
      })
      const result = await ctx.waterfall(
        'test/waterfall',
        [],
        async () => 'final',
      )
      expect(result).toBe('short-circuited')
    })
  })

  describe('effect / lifecycle', () => {
    it('effect registers disposer', () => {
      let disposed = false
      ctx.effect(() => {
        return () => { disposed = true }
      })
      expect(disposed).toBe(false)
    })

    it('dispose() cleans up all effects', async () => {
      let disposed1 = false
      let disposed2 = false
      ctx.effect(() => {
        return () => { disposed1 = true }
      })
      ctx.effect(() => {
        return () => { disposed2 = true }
      })
      await ctx.dispose()
      expect(disposed1).toBe(true)
      expect(disposed2).toBe(true)
    })

    it('effect without disposer is fine', () => {
      ctx.effect(() => {
        // no return
      })
      // 不报错即可
      expect(true).toBe(true)
    })
  })

  describe('scope / extend', () => {
    it('extend creates child context with inherited services', () => {
      ctx.plugin(TestService as any)
      const child = ctx.extend()
      expect((child as any).test).toBe((ctx as any).test)
    })

    it('child context has independent effect lifecycle', async () => {
      let parentDisposed = false
      let childDisposed = false
      ctx.effect(() => () => { parentDisposed = true })
      const child = ctx.extend()
      child.effect(() => () => { childDisposed = true })

      await child.dispose()
      expect(childDisposed).toBe(true)
      expect(parentDisposed).toBe(false)

      await ctx.dispose()
      expect(parentDisposed).toBe(true)
    })

    it('extend with overrides adds properties', () => {
      const child = ctx.extend({ custom: 'value' })
      expect((child as any).custom).toBe('value')
    })
  })

  describe('declareEvent', () => {
    it('declareEvent registers event mode', () => {
      ctx.declareEvent('test/declared', 'emit')
      // 不报错即可，事件模式声明目前主要用于文档和类型
      expect(true).toBe(true)
    })
  })
})
