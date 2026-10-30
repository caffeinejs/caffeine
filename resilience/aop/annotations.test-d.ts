import { describe, it } from 'vitest'

import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from './annotations.js'

interface Stock {
  readonly id: string
  readonly count: number
}

// Every class here only exists for the compiler: the file is type-checked, never run.
describe('resilience annotations', () => {
  it('go on a method that returns a promise', () => {
    class InventoryClient {
      @Retry('inventory', { repeatable: true })
      @CircuitBreaker('inventory')
      @TimeLimiter('inventory')
      @Bulkhead('inventory')
      @RateLimiter('inventory')
      async stock(id: string, signal?: AbortSignal): Promise<Stock> {
        void signal
        return { id, count: 1 }
      }
    }
    void InventoryClient
  })

  // A strategy settles a call later: on a method that answers at once, it would turn its value into a promise.
  it('refuse a method that does not return a promise', () => {
    class InventoryClient {
      // @ts-expect-error -- not a promise-returning method
      @Retry('inventory')
      count(): number {
        return 1
      }

      // @ts-expect-error -- not a promise-returning method
      @CircuitBreaker('inventory')
      name(): string {
        return 'inventory'
      }
    }
    void InventoryClient
  })

  it('refuse a class and a field', () => {
    // @ts-expect-error -- method decorators only
    @TimeLimiter('inventory')
    class InventoryClient {
      // @ts-expect-error -- method decorators only
      @Bulkhead('inventory')
      pool = 1
    }
    void InventoryClient
  })
})

describe('@Fallback', () => {
  it('takes a method of the class that accepts the error, then the original arguments', () => {
    class InventoryClient {
      @Fallback('cachedStock')
      async stock(id: string, signal?: AbortSignal): Promise<Stock> {
        void signal
        return { id, count: 1 }
      }

      async cachedStock(error: unknown, id: string): Promise<Stock> {
        void error
        return { id, count: 0 }
      }
    }
    void InventoryClient
  })

  it('refuses a name that is not a member of the class', () => {
    class InventoryClient {
      // @ts-expect-error -- no member "cachedStok"
      @Fallback('cachedStok')
      async stock(id: string): Promise<Stock> {
        return { id, count: 1 }
      }

      async cachedStock(_error: unknown, id: string): Promise<Stock> {
        return { id, count: 0 }
      }
    }
    void InventoryClient
  })

  it('refuses a member that is not a method', () => {
    class InventoryClient {
      cached: Stock = { id: '0', count: 0 }

      // @ts-expect-error -- "cached" is a field
      @Fallback('cached')
      async stock(id: string): Promise<Stock> {
        return { id, count: 1 }
      }
    }
    void InventoryClient
  })

  it('refuses a method whose arguments do not match', () => {
    class InventoryClient {
      // @ts-expect-error -- cachedStock takes a number where stock passes a string
      @Fallback('cachedStock')
      async stock(id: string): Promise<Stock> {
        return { id, count: 1 }
      }

      async cachedStock(_error: unknown, id: number): Promise<Stock> {
        return { id: String(id), count: 0 }
      }
    }
    void InventoryClient
  })

  it('refuses a method that does not resolve to what the decorated one does', () => {
    class InventoryClient {
      // @ts-expect-error -- cachedStock resolves to a string
      @Fallback('cachedStock')
      async stock(id: string): Promise<Stock> {
        return { id, count: 1 }
      }

      async cachedStock(_error: unknown, id: string): Promise<string> {
        return id
      }

      // @ts-expect-error -- cachedCount does not return a promise
      @Fallback('cachedCount')
      async count(id: string): Promise<number> {
        void id
        return 1
      }

      cachedCount(_error: unknown, _id: string): number {
        return 0
      }
    }
    void InventoryClient
  })
})
