import { describe, it, expect, vi } from 'vitest'
import { DeferredCtor } from '../deferred_ctor.js'

describe('DeferredCtor', function () {
  describe('unwrap()', function () {
    it('should return the key from the callback', function () {
      class Svc {}
      const deferred = new DeferredCtor(() => Svc)
      expect(deferred.unwrap()).toBe(Svc)
    })
  })

  describe('createProxy() — lazy initialization', function () {
    it('should not call the creator until the proxy is first accessed', function () {
      class Svc {}
      const creator = vi.fn(() => new Svc())
      const deferred = new DeferredCtor(() => Svc)
      deferred.createProxy(creator)
      expect(creator).not.toHaveBeenCalled()
    })

    it('should call the creator exactly once across multiple property accesses', function () {
      class Svc {
        value = 42
      }
      const creator = vi.fn(() => new Svc())
      const deferred = new DeferredCtor(() => Svc)
      const proxy = deferred.createProxy(creator)

      void (proxy as Svc).value
      void (proxy as Svc).value
      void (proxy as Svc).value

      expect(creator).toHaveBeenCalledTimes(1)
    })
  })

  describe('createProxy() — proxy correctness', function () {
    class Counter {
      count = 0

      increment() {
        this.count++
        return this
      }

      get doubled() {
        return this.count * 2
      }
    }

    function makeProxy() {
      const deferred = new DeferredCtor(() => Counter)
      return deferred.createProxy(ctor => new (ctor as typeof Counter)())
    }

    it('should transparently expose properties of the underlying instance', function () {
      const proxy = makeProxy() as Counter
      expect(proxy.count).toBe(0)
    })

    it('should transparently call methods on the underlying instance', function () {
      const proxy = makeProxy() as Counter
      proxy.increment()
      expect(proxy.count).toBe(1)
    })

    it('should expose getter properties on the underlying instance', function () {
      const proxy = makeProxy() as Counter
      proxy.increment().increment()
      expect(proxy.doubled).toBe(4)
    })

    it('should allow setting properties on the underlying instance through the proxy', function () {
      const proxy = makeProxy() as Counter
      proxy.count = 10
      expect(proxy.count).toBe(10)
    })

    it('should report properties as present via the "in" operator', function () {
      const proxy = makeProxy() as Counter
      expect('count' in proxy).toBe(true)
      expect('increment' in proxy).toBe(true)
      expect('nonexistent' in proxy).toBe(false)
    })

    it('should return true when checking instanceof the proxied class', function () {
      const proxy = makeProxy() as Counter
      expect(proxy instanceof Counter).toBe(true)
    })

    it('should forward the correct key to the creator callback', function () {
      class SpecificService {
        value = 1
      }
      let capturedKey: unknown
      const deferred = new DeferredCtor(() => SpecificService)
      const proxy = deferred.createProxy(ctor => {
        capturedKey = ctor
        return new (ctor as typeof SpecificService)()
      })

      void (proxy as SpecificService).value
      expect(capturedKey).toBe(SpecificService)
    })
  })
})
