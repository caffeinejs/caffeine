import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Configuration } from '../configuration.legacy.js'
import { Provides } from '../provides.legacy.js'
import { Async } from '../async.legacy.js'

describe('Legacy @Async', function () {
  describe('async @Provides factory', function () {
    class AsyncConn {
      constructor(readonly status: string) {}
    }

    @Configuration()
    class AsyncConnConfig {
      @Async()
      @Provides(AsyncConn)
      async conn(): Promise<AsyncConn> {
        return new AsyncConn('ready')
      }
    }

    void AsyncConnConfig

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves async provider synchronously after init', function () {
      const conn = di.get(AsyncConn)
      expect(conn).toBeInstanceOf(AsyncConn)
      expect(conn.status).toBe('ready')
    })
  })

  describe('validation', function () {
    it('throws when applied to a non-method member', function () {
      const decorator = Async()
      expect(() => {
        decorator({}, 'prop', undefined as unknown as PropertyDescriptor)
      }).toThrow()
    })

    it('throws when applied to a getter (no descriptor.value)', function () {
      const decorator = Async()
      expect(() => {
        decorator({}, 'prop', { get: () => 'value' } as PropertyDescriptor)
      }).toThrow()
    })
  })
})
