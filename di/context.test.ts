import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from './container.js'
import { bindContextStorageFactory, contextKey, ContextStorage, ExecutionContext } from './context.js'

describe('ExecutionContext', () => {
  // A frame started inside another extends it without changing what the outer frame sees.
  it('reads a slot set by with, and leaves the context it came from as it was', () => {
    const kTenant = contextKey<string>('tenant')
    const inner = ExecutionContext.ROOT.with(kTenant, 'acme')

    expect(inner.get(kTenant)).toBe('acme')
    expect(ExecutionContext.ROOT.get(kTenant)).toBe(undefined)
  })

  it('reads the value set last when a slot is set again', () => {
    const kTenant = contextKey<string>('tenant')

    expect(ExecutionContext.ROOT.with(kTenant, 'outer').with(kTenant, 'inner').get(kTenant)).toBe('inner')
  })

  it('keeps two keys made with one description apart', () => {
    const first = contextKey<string>('tenant')
    const second = contextKey<string>('tenant')
    const context = ExecutionContext.ROOT.with(first, 'a')

    expect(context.get(first)).toBe('a')
    expect(context.get(second)).toBe(undefined)
  })
})

describe('bindContextStorageFactory', () => {
  // A container takes the factory once, when it is constructed: one built before has none.
  it('gives each container constructed after it a storage of its own', async () => {
    const before = new CaffeineIoC({ decorators: false })
    bindContextStorageFactory(() => new AsyncLocalStorage<ExecutionContext>())
    const a = new CaffeineIoC({ decorators: false })
    const b = new CaffeineIoC({ decorators: false })
    await Promise.all([before.init(), a.init(), b.init()])

    expect(before.has(ContextStorage)).toBe(false)
    expect(a.get(ContextStorage)).toBeInstanceOf(AsyncLocalStorage)
    expect(a.get(ContextStorage)).not.toBe(b.get(ContextStorage))
  })
})
