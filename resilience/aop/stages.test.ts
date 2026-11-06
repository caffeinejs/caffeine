import { describe, expect, it } from 'vitest'

import { Resilient, Retry } from './annotations.js'
import { ResilienceRegistry } from './registry.js'
import { stagesOf } from './stages.js'

const registry = new ResilienceRegistry({
  all: { retry: {}, circuitBreaker: {} },
  orders: { retry: {} },
  ledger: { circuitBreaker: {} },
})

const source = (preset: string, decorator: string) => ({ preset, decorator })

// `repeatable` permits replaying a method, such as an HTTP handler that writes. It must come from the annotation that
// gives the method its retry, so a broader annotation can never permit a replay the closer one refuses.
describe('stagesOf(...).repeatable', () => {
  it("keeps a method's own @Retry repeatable: false under a class @Resilient that says true", () => {
    @Resilient('all', { repeatable: true })
    class Orders {
      @Retry('orders', { repeatable: false })
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('orders', 'Retry'))
    expect(repeatable).toBe(false)
  })

  it('takes repeatable from @Retry over @Resilient on the same method', () => {
    class Orders {
      @Retry('orders', { repeatable: false })
      @Resilient('all', { repeatable: true })
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('orders', 'Retry'))
    expect(repeatable).toBe(false)
  })

  it("does not let a class @Retry's repeatable reach a method whose own @Resilient retries it", () => {
    @Retry('orders', { repeatable: true })
    class Orders {
      @Resilient('all')
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('all', 'Resilient'))
    expect(repeatable).toBe(false)
  })

  // The method's @Resilient names a preset with no retry, so the class's @Retry is what retries it.
  it('ignores repeatable on a @Resilient that gives the method no retry', () => {
    @Retry('orders')
    class Orders {
      @Resilient('ledger', { repeatable: true })
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('orders', 'Retry'))
    expect(stages.circuitBreaker).toEqual(source('ledger', 'Resilient'))
    expect(repeatable).toBe(false)
  })

  it("takes a method's own @Retry repeatable: true under a class @Resilient", () => {
    @Resilient('all')
    class Orders {
      @Retry('orders', { repeatable: true })
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('orders', 'Retry'))
    expect(repeatable).toBe(true)
  })

  it('takes repeatable from a class @Resilient that retries every method', () => {
    @Resilient('all', { repeatable: true })
    class Orders {
      async place(): Promise<void> {}
    }

    const { stages, repeatable } = stagesOf(Orders, 'place', registry)

    expect(stages.retry).toEqual(source('all', 'Resilient'))
    expect(repeatable).toBe(true)
  })
})
