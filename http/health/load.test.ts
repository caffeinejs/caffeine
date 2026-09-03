import { describe, expect, it } from 'vitest'
import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import { HealthIndicator, type HealthReport, up } from '@caffeinejs/std'
import { ErrHealthIndicatorNotSingleton } from './errors.js'
import { loadHealthIndicators } from './load.js'

class Stub extends HealthIndicator {
  get name(): string {
    return 'stub'
  }

  check(): HealthReport {
    return up()
  }
}

describe('loadHealthIndicators', () => {
  it('returns an empty list when none are bound', async () => {
    const container = new CaffeineIoC({ decorators: false })
    await container.init()

    expect(loadHealthIndicators(container)).toEqual([])
  })

  it('returns a default-scoped indicator', async () => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Stub, t => t.toSelf().extends(HealthIndicator))
    await container.init()

    const [indicator] = loadHealthIndicators(container)

    expect(indicator).toBeInstanceOf(Stub)
  })

  it.each([
    ['transient', Scopes.TRANSIENT],
    ['request', Scopes.REQUEST],
    ['refresh', Scopes.REFRESH],
  ] as const)('rejects a %s indicator', async (_label, scope) => {
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Stub, t => t.toSelf().lifetime(scope).extends(HealthIndicator))
    await container.init()

    expect(() => loadHealthIndicators(container)).toThrow(ErrHealthIndicatorNotSingleton)
    expect(() => loadHealthIndicators(container)).toThrow(/"Stub"/)
  })
})
