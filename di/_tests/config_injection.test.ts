import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { ErrNoValuesProvider } from '../errors.js'
import { $i } from '../injection.js'
import { configFactory } from '../internal/core/resolver/index.js'

function ctx(
  container: CaffeineIoC,
  descriptor: ReturnType<typeof $i.value> | ReturnType<typeof $i.optional>,
  key: any = 'Consumer',
) {
  return { container, descriptor, key, kind: 'constructor' as const, member: '', index: 0 }
}

describe('$i.config', function () {
  describe('validation', function () {
    it('throws ErrNoValuesProvider when no provider is registered and injection is required', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => configFactory(ctx(di, $i.value(cfg => cfg))))
        .toThrow(ErrNoValuesProvider)
    })

    it('does not throw when optional and no provider is registered', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => configFactory(ctx(di, $i.optional($i.value(cfg => cfg)))))
        .not.toThrow()
    })

    it('returns a resolver that yields undefined when optional and no provider is registered', function () {
      const di = new CaffeineIoC({ decorators: false })

      const resolver = configFactory(ctx(di, $i.optional($i.value(cfg => cfg))))
      expect(resolver()).toBeUndefined()
    })
  })

  describe('resolution', function () {
    it('resolves a string value via selector', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>().toValue({ host: 'localhost' })
      di.bind(Svc).toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)])
      await di.init()

      expect(di.get(Svc).host).toBe('localhost')
    })

    it('resolves a number value via selector', async function () {
      class Svc {
        constructor(readonly port: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ port: number }>().toValue({ port: 5432 })
      di.bind(Svc).toClass(Svc, [$i.value<{ port: number }>(cfg => cfg.port)])
      await di.init()

      expect(di.get(Svc).port).toBe(5432)
    })

    it('resolves a boolean value via selector', async function () {
      class Svc {
        constructor(readonly enabled: boolean) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ enabled: boolean }>().toValue({ enabled: true })
      di.bind(Svc).toClass(Svc, [$i.value<{ enabled: boolean }>(cfg => cfg.enabled)])
      await di.init()

      expect(di.get(Svc).enabled).toBe(true)
    })

    it('navigates nested properties via selector', async function () {
      type Cfg = { database: { host: string, port: number } }

      class Svc {
        constructor(readonly host: string, readonly port: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>().toValue({ database: { host: 'db.local', port: 3306 } })
      di.bind(Svc).toClass(Svc, [
        $i.value<Cfg>(cfg => cfg.database.host),
        $i.value<Cfg>(cfg => cfg.database.port),
      ])
      await di.init()

      expect(di.get(Svc).host).toBe('db.local')
      expect(di.get(Svc).port).toBe(3306)
    })

    it('resolves from a class-based provider bound with toClass', async function () {
      class AppCfg {
        readonly host = 'class-host'
        readonly port = 9000
      }

      class Svc {
        constructor(readonly host: string, readonly port: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<AppCfg>().toClass(AppCfg)
      di.bind(Svc).toClass(Svc, [
        $i.value<AppCfg>(cfg => cfg.host),
        $i.value<AppCfg>(cfg => cfg.port),
      ])
      await di.init()

      expect(di.get(Svc).host).toBe('class-host')
      expect(di.get(Svc).port).toBe(9000)
    })

    it('resolves multiple independent config injections from the same provider', async function () {
      type Cfg = { a: string, b: string, c: string }

      class Svc {
        constructor(readonly a: string, readonly b: string, readonly c: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>().toValue({ a: 'alpha', b: 'beta', c: 'gamma' })
      di.bind(Svc).toClass(Svc, [
        $i.value<Cfg>(cfg => cfg.a),
        $i.value<Cfg>(cfg => cfg.b),
        $i.value<Cfg>(cfg => cfg.c),
      ])
      await di.init()

      const svc = di.get(Svc)
      expect(svc.a).toBe('alpha')
      expect(svc.b).toBe('beta')
      expect(svc.c).toBe('gamma')
    })
  })

  describe('optional', function () {
    it('returns undefined when optional and provider is absent', async function () {
      class Svc {
        constructor(readonly host: string | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc).toClass(Svc, [$i.optional($i.value<{ host: string }>(cfg => cfg.host))])
      await di.init()

      expect(di.get(Svc).host).toBeUndefined()
    })

    it('resolves value when optional and provider is present', async function () {
      class Svc {
        constructor(readonly host: string | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>().toValue({ host: 'optional-host' })
      di.bind(Svc).toClass(Svc, [$i.optional($i.value<{ host: string }>(cfg => cfg.host))])
      await di.init()

      expect(di.get(Svc).host).toBe('optional-host')
    })
  })

  describe('factory provider', function () {
    it('works with a factory-based provider bound with toFactory', async function () {
      type Cfg = { dsn: string }

      class Svc {
        constructor(readonly dsn: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>().toFactory(() => ({ dsn: 'postgres://localhost/db' }))
      di.bind(Svc).toClass(Svc, [$i.value<Cfg>(cfg => cfg.dsn)])
      await di.init()

      expect(di.get(Svc).dsn).toBe('postgres://localhost/db')
    })
  })

  describe('error at init time', function () {
    it('throws ErrNoValuesProvider during init when provider is absent and injection is required', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc).toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)])

      await expect(di.init()).rejects.toThrow(ErrNoValuesProvider)
    })
  })
})
