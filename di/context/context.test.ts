import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import { ErrInvalidContainerState } from '../errors.js'
import { CaffeineIoC, Scopes } from '../index.nodejs.js'
import { contextKey, ContextStorage, ExecutionContext } from './context.js'

const kTenant = contextKey<string>('tenant')
const kAttempt = contextKey<number>('attempt')

async function container(configure: (di: CaffeineIoC) => void = () => undefined): Promise<CaffeineIoC> {
  const di = new CaffeineIoC({ decorators: false })
  configure(di)
  await di.init()
  return di
}

describe('ExecutionContext', () => {
  // A frame shared by every consumer must never change under an outer frame that holds it.
  it('leaves the context it extends unchanged', () => {
    const outer = ExecutionContext.ROOT.with(kTenant, 'acme')
    const inner = outer.with(kTenant, 'globex').with(kAttempt, 2)

    expect(outer.get(kTenant)).toBe('acme')
    expect(outer.get(kAttempt)).toBe(undefined)
    expect(inner.get(kTenant)).toBe('globex')
    expect(inner.get(kAttempt)).toBe(2)
    expect(ExecutionContext.ROOT.get(kTenant)).toBe(undefined)
  })

  it('removes one slot and keeps the others', () => {
    const both = ExecutionContext.ROOT.with(kTenant, 'acme').with(kAttempt, 1)
    const tenantOnly = both.without(kAttempt)

    expect(tenantOnly.get(kTenant)).toBe('acme')
    expect(tenantOnly.get(kAttempt)).toBe(undefined)
    expect(both.get(kAttempt)).toBe(1)
    expect(tenantOnly.without(kAttempt)).toBe(tenantOnly)
  })

  // Two packages naming a slot alike must not read each other's value.
  it('keeps two keys with the same description apart', () => {
    const a = contextKey<string>('same')
    const b = contextKey<string>('same')

    expect(ExecutionContext.ROOT.with(a, 'a').get(b)).toBe(undefined)
  })
})

describe('container.contextStorage', () => {
  it('is an AsyncLocalStorage of its own in every container on Node', async () => {
    const first = await container()
    const second = await container()

    expect(first.contextStorage).toBeInstanceOf(AsyncLocalStorage)
    expect(first.contextStorage).toBe(first.contextStorage)
    expect(first.contextStorage).not.toBe(second.contextStorage)
  })

  it('refuses a read before init()', () => {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.contextStorage).toThrow(ErrInvalidContainerState)
  })

  // An application or a test container providing its own storage must be the one every consumer shares.
  it('is the storage the application binds, and the request scope keeps its frames there', async () => {
    const storage = new AsyncLocalStorage<ExecutionContext>()
    class Session {}
    const di = await container(c => {
      c.bind(ContextStorage, t => t.toValue(storage))
      c.bind(Session, t => t.toSelf().lifetime(Scopes.REQUEST))
    })

    expect(di.contextStorage).toBe(storage)
    const seen = await di.requestScopeManager.run(() => ({
      framed: storage.getStore() !== undefined,
      session: di.get(Session),
    }))
    expect(seen.framed).toBe(true)
    expect(seen.session).toBeInstanceOf(Session)
  })
})
