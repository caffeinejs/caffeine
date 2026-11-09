import { Hour, Second } from '@caffeinejs/std/duration'
import { describe, it } from 'vitest'

import { LeaderOnly } from './leader_only.js'
import { Once } from './once.js'
import { OneAtATime } from './one_at_a_time.js'

// Every class here only exists for the compiler: the file is type-checked, never run.
describe('distlock decorators', () => {
  it('go on a method whose promise may resolve to undefined', () => {
    class Jobs {
      @Once('cache:warm', { ttl: 1 * Hour })
      async warm(): Promise<void> {}

      @OneAtATime('catalog:sync', { renew: false })
      async sync(id: string): Promise<number | undefined> {
        return id.length
      }

      @LeaderOnly('scheduler')
      async tick(): Promise<void> {}
    }
    void Jobs
  })

  // A skipped call resolves to undefined: a method typed to always resolve to a value would lie to its callers.
  it('refuse a method whose promise never resolves to undefined', () => {
    class Jobs {
      // @ts-expect-error -- Promise<number> excludes the undefined a skipped call resolves to
      @OneAtATime('catalog:sync')
      async count(): Promise<number> {
        return 1
      }
    }
    void Jobs
  })

  // The guarded call settles later, so on a method that answers at once it would turn its value into a promise.
  it('refuse a method that does not return a promise', () => {
    class Jobs {
      // @ts-expect-error -- not a promise-returning method
      @Once('cache:warm')
      warm(): void {}
    }
    void Jobs
  })

  it('refuse an option the call does not take', () => {
    class Jobs {
      // @ts-expect-error -- tryWithLock never waits
      @OneAtATime('catalog:sync', { wait: 1 * Second })
      async sync(): Promise<void> {}
    }
    void Jobs
  })
})
