import { describe, it, expect, vi } from 'vitest'

import { RequestScopeContext } from './request_context.js'

describe('RequestScopeContext', function () {
  it('should report itself destroyed and run each hook once across repeated destroy() calls', async function () {
    const cb = vi.fn()
    const context = new RequestScopeContext()
    const instance = {}

    context.set(1, instance)
    context.registerDestroy(instance, cb)

    expect(context.destroyed).toBe(false)

    await context.destroy()
    await context.destroy()

    expect(context.destroyed).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(instance)
    expect(context.get(1)).toBeUndefined()
  })

  it('should stay destroyed when it held no instances', async function () {
    const context = new RequestScopeContext()

    await context.destroy()

    expect(context.destroyed).toBe(true)
  })

  // A dependency has to still be usable while the hook of whatever depends on it runs, so the instance
  // created last is the first one destroyed.
  it('should destroy in reverse creation order, one hook at a time', async function () {
    const order: string[] = []
    const context = new RequestScopeContext()

    context.registerDestroy({ name: 'repo' }, async () => {
      order.push('repo:start')
      await Promise.resolve()
      order.push('repo:end')
    })
    context.registerDestroy({ name: 'service' }, async () => {
      order.push('service:start')
      await Promise.resolve()
      order.push('service:end')
    })

    await context.destroy()

    expect(order).toEqual(['service:start', 'service:end', 'repo:start', 'repo:end'])
  })

  // Two bindings can hand back the same object. Closing the resource twice is what the identity check exists
  // to prevent.
  it('should run one hook per instance when two bindings share it', async function () {
    const shared = { closed: 0 }
    const context = new RequestScopeContext()

    context.registerDestroy(shared, s => {
      s.closed++
    })
    context.registerDestroy(shared, s => {
      s.closed++
    })

    await context.destroy()

    expect(shared.closed).toBe(1)
  })

  it('should keep a hook per value when the instances are primitives', async function () {
    const seen: number[] = []
    const context = new RequestScopeContext()

    context.registerDestroy(8080, v => void seen.push(v))
    context.registerDestroy(8080, v => void seen.push(v))

    await context.destroy()

    expect(seen).toEqual([8080, 8080])
  })

  it('should run every remaining hook when one throws and report the failures together', async function () {
    const after = vi.fn()
    const context = new RequestScopeContext()

    context.registerDestroy({ name: 'first-created' }, after)
    context.registerDestroy({ name: 'last-created' }, () => {
      throw new Error('boom')
    })

    await expect(context.destroy()).rejects.toThrow(AggregateError)
    expect(after).toHaveBeenCalledTimes(1)
    expect(context.destroyed).toBe(true)
  })
})
