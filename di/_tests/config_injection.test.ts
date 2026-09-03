import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrNoValuesProvider } from '../errors.js'
import { $i } from '../injection.js'
import { configFactory } from '../internal/core/resolver/index.js'
import { Scopes } from '../scope.js'
import { Keys } from '../symbols.js'

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

      expect(() =>
        configFactory(
          ctx(
            di,
            $i.value(cfg => cfg),
          ),
        ),
      ).toThrow(ErrNoValuesProvider)
    })

    it('does not throw when optional and no provider is registered', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => configFactory(ctx(di, $i.optional($i.value(cfg => cfg))))).not.toThrow()
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
      di.bindValuesProvider<{ host: string }>(t => t.toValue({ host: 'localhost' }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))
      await di.init()

      expect(di.get(Svc).host).toBe('localhost')
    })

    it('resolves a number value via selector', async function () {
      class Svc {
        constructor(readonly port: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ port: number }>(t => t.toValue({ port: 5432 }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ port: number }>(cfg => cfg.port)]))
      await di.init()

      expect(di.get(Svc).port).toBe(5432)
    })

    it('resolves a boolean value via selector', async function () {
      class Svc {
        constructor(readonly enabled: boolean) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ enabled: boolean }>(t => t.toValue({ enabled: true }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ enabled: boolean }>(cfg => cfg.enabled)]))
      await di.init()

      expect(di.get(Svc).enabled).toBe(true)
    })

    it('navigates nested properties via selector', async function () {
      type Cfg = { database: { host: string; port: number } }

      class Svc {
        constructor(
          readonly host: string,
          readonly port: number,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>(t => t.toValue({ database: { host: 'db.local', port: 3306 } }))
      di.bind(Svc, t =>
        t.toClass(Svc, [$i.value<Cfg>(cfg => cfg.database.host), $i.value<Cfg>(cfg => cfg.database.port)]),
      )
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
        constructor(
          readonly host: string,
          readonly port: number,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<AppCfg>(t => t.toClass(AppCfg))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<AppCfg>(cfg => cfg.host), $i.value<AppCfg>(cfg => cfg.port)]))
      await di.init()

      expect(di.get(Svc).host).toBe('class-host')
      expect(di.get(Svc).port).toBe(9000)
    })

    it('resolves multiple independent config injections from the same provider', async function () {
      type Cfg = { a: string; b: string; c: string }

      class Svc {
        constructor(
          readonly a: string,
          readonly b: string,
          readonly c: string,
        ) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>(t => t.toValue({ a: 'alpha', b: 'beta', c: 'gamma' }))
      di.bind(Svc, t =>
        t.toClass(Svc, [$i.value<Cfg>(cfg => cfg.a), $i.value<Cfg>(cfg => cfg.b), $i.value<Cfg>(cfg => cfg.c)]),
      )
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
      di.bind(Svc, t => t.toClass(Svc, [$i.optional($i.value<{ host: string }>(cfg => cfg.host))]))
      await di.init()

      expect(di.get(Svc).host).toBeUndefined()
    })

    it('resolves value when optional and provider is present', async function () {
      class Svc {
        constructor(readonly host: string | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>(t => t.toValue({ host: 'optional-host' }))
      di.bind(Svc, t => t.toClass(Svc, [$i.optional($i.value<{ host: string }>(cfg => cfg.host))]))
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
      di.bindValuesProvider<Cfg>(t => t.toFactory(() => ({ dsn: 'postgres://localhost/db' })))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<Cfg>(cfg => cfg.dsn)]))
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
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))

      await expect(di.init()).rejects.toThrow(ErrNoValuesProvider)
    })
  })

  describe('string path access', function () {
    it('resolves a top-level key via string path', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>(t => t.toValue({ host: 'path-host' }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host')]))
      await di.init()

      expect(di.get(Svc).host).toBe('path-host')
    })

    it('resolves a nested key via string path', async function () {
      type Cfg = { database: { host: string } }

      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>(t => t.toValue({ database: { host: 'nested-host' } }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('database.host')]))
      await di.init()

      expect(di.get(Svc).host).toBe('nested-host')
    })

    it('resolves a deeply nested key via string path', async function () {
      type Cfg = { a: { b: { c: string } } }

      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Cfg>(t => t.toValue({ a: { b: { c: 'deep' } } }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('a.b.c')]))
      await di.init()

      expect(di.get(Svc).val).toBe('deep')
    })

    it('returns undefined for a missing intermediate key without throwing', async function () {
      class Svc {
        constructor(readonly val: unknown) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Record<string, unknown>>(t => t.toValue({}))
      di.bind(Svc, t => t.toClass(Svc, [$i.optional($i.value('missing.key'))]))
      await di.init()

      expect(di.get(Svc).val).toBeUndefined()
    })
  })

  describe('default value', function () {
    it('selector form: returns default when resolved value is undefined', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host?: string }>(t => t.toValue({}))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host?: string }>(cfg => cfg.host, 'default-host')]))
      await di.init()

      expect(di.get(Svc).val).toBe('default-host')
    })

    it('string path form: returns default when path resolves to undefined', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Record<string, unknown>>(t => t.toValue({}))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host', 'path-default')]))
      await di.init()

      expect(di.get(Svc).val).toBe('path-default')
    })

    it('does not use default when value is present and defined', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>(t => t.toValue({ host: 'real-host' }))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host', 'should-not-appear')]))
      await di.init()

      expect(di.get(Svc).val).toBe('real-host')
    })

    it('non-optional with default succeeds when provider is absent', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host', 'absent-default')]))
      await di.init()

      expect(di.get(Svc).val).toBe('absent-default')
    })

    it('optional with default returns default when provider is absent', async function () {
      class Svc {
        constructor(readonly val: string | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toClass(Svc, [$i.optional($i.value('host', 'opt-default'))]))
      await di.init()

      expect(di.get(Svc).val).toBe('opt-default')
    })
  })

  describe('getter-based provider', function () {
    it('selector form invokes getter on provider class', async function () {
      class AppConfig {
        private _host = 'computed-host'
        get host() {
          return this._host
        }
      }

      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<AppConfig>(t => t.toClass(AppConfig))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<AppConfig>(cfg => cfg.host)]))
      await di.init()

      expect(di.get(Svc).host).toBe('computed-host')
    })

    it('string path form invokes getter on provider class', async function () {
      class AppConfig {
        private _host = 'path-computed-host'
        get host() {
          return this._host
        }
      }

      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<AppConfig>(t => t.toClass(AppConfig))
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host')]))
      await di.init()

      expect(di.get(Svc).host).toBe('path-computed-host')
    })

    it('getter computing from multiple this fields works correctly', async function () {
      class AppConfig {
        readonly scheme = 'https'
        readonly domain = 'example.com'
        get baseURL() {
          return `${this.scheme}://${this.domain}`
        }
      }

      class Svc {
        constructor(readonly url: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<AppConfig>(t => t.toClass(AppConfig))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<AppConfig>(cfg => cfg.baseURL)]))
      await di.init()

      expect(di.get(Svc).url).toBe('https://example.com')
    })
  })

  describe('refresh and reload', function () {
    it('transient consumer sees mutation on the provider object between constructions', async function () {
      const config = { host: 'initial' }

      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<typeof config>(t => t.toFactory(() => config))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<typeof config>(c => c.host)]).lifetime(Scopes.TRANSIENT))
      await di.init()

      expect(di.get(Svc).host).toBe('initial')
      config.host = 'updated'
      expect(di.get(Svc).host).toBe('updated')
    })

    it('transient consumer picks up new provider instance after resetInstance', async function () {
      let counter = 0

      class Svc {
        constructor(readonly n: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ n: number }>(t => t.toFactory(() => ({ n: ++counter })))
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ n: number }>(c => c.n)]).lifetime(Scopes.TRANSIENT))
      await di.init()

      expect(di.get(Svc).n).toBe(1)
      await di.resetInstance(Keys.kValuesProvider)
      expect(di.get(Svc).n).toBe(2)
    })
  })
})
