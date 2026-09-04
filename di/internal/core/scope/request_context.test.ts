import { describe, it, expect, vi } from 'vitest'

import { RequestScopeContext } from './request_context.js'

describe('RequestScopeContext', function () {
  it('should report itself destroyed and run each callback once across repeated destroy() calls', async function () {
    const cb = vi.fn()
    const context = new RequestScopeContext()

    context.set(1, {})
    context.registerDestroyCallback(cb)

    expect(context.destroyed).toBe(false)

    await context.destroy()
    await context.destroy()

    expect(context.destroyed).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(context.get(1)).toBeUndefined()
  })

  it('should stay destroyed when it held no instances', async function () {
    const context = new RequestScopeContext()

    await context.destroy()

    expect(context.destroyed).toBe(true)
  })
})
