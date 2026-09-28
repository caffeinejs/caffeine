import { describe, it, expect, expectTypeOf } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ErrInvalidContainerState, ErrNoValuesProvider } from '../errors.js'
import { $i } from '../injection.js'
import { compileChain } from '../internal/core/resolver/index.js'
import { mod } from '../module.js'
import { Scopes } from '../scope.js'

function ctx(
  container: CaffeineIoC,
  descriptor: ReturnType<typeof $i.value> | ReturnType<typeof $i.optional>,
  key: any = 'Consumer',
) {
  return { container, descriptor, key, kind: 'constructor' as const, member: '', index: 0 }
}

describe('bindValuesProvider', function () {
  it('takes the values themselves, not a callback that binds them', function () {
    const di = new CaffeineIoC({ decorators: false })

    expectTypeOf(di.bindValuesProvider<{ host: string }>)
      .parameter(0)
      .toEqualTypeOf<{ host: string }>()
  })

  it('makes reading the values throw ErrNoValuesProvider when nothing was bound', function () {
    const di = new CaffeineIoC({ decorators: false })
    const read = () => di.values

    expect(di.hasValues).toBe(false)
    expect(read).toThrow(ErrNoValuesProvider)
    // A read is not an injection, so there is no injection site to name after the fix.
    expect(read).toThrow(/call bindValuesProvider\(\) before init\(\)$/)
  })

  it('holds the object it is given, not a copy, before and after init', async function () {
    const values = { host: 'localhost' }
    const di = new CaffeineIoC({ decorators: false })

    expect(di.hasValues).toBe(false)
    expect(di.bindValuesProvider(values)).toBe(di)
    expect(di.hasValues).toBe(true)
    expect(di.values).toBe(values)

    await di.init()

    expect(di.values).toBe(values)
  })

  // Either would read back as "nothing bound", so the mistake would surface only as a missing value somewhere else.
  it('rejects undefined and null', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.bindValuesProvider(undefined)).toThrow('Parameter values must not be null or undefined')
    expect(() => di.bindValuesProvider(null)).toThrow('Parameter values must not be null or undefined')
    expect(di.hasValues).toBe(false)
  })

  it('adds no binding, because the values are not an injectable', function () {
    const di = new CaffeineIoC({ decorators: false })
    const size = di.size

    di.bindValuesProvider({ host: 'localhost' })

    expect(di.size).toBe(size)
  })

  it('replaces the values when called again before init', async function () {
    class Svc {
      constructor(readonly host: string) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindValuesProvider({ host: 'first' })
    di.bindValuesProvider({ host: 'second' })
    di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))
    await di.init()

    expect(di.get(Svc).host).toBe('second')
  })

  // The injections compiled by then already hold the values, so a later call would reach none of them.
  it('throws ErrInvalidContainerState once the container has compiled', async function () {
    const compiled = new CaffeineIoC({ decorators: false })
    await compiled.compile()

    expect(() => compiled.bindValuesProvider({ host: 'late' })).toThrow(ErrInvalidContainerState)
    expect(compiled.hasValues).toBe(false)

    const initialized = new CaffeineIoC({ decorators: false })
    await initialized.init()

    expect(() => initialized.bindValuesProvider({ host: 'late' })).toThrow(ErrInvalidContainerState)
    expect(initialized.hasValues).toBe(false)
  })

  it('can be called from a module, which runs before the container compiles', async function () {
    class Svc {
      constructor(readonly host: string) {}
    }

    const di = new CaffeineIoC({
      decorators: false,
      modules: [mod('values', container => container.bindValuesProvider({ host: 'from-module' }))],
    })
    di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))
    await di.init()

    expect(di.get(Svc).host).toBe('from-module')
  })
})

describe('$i.value', function () {
  describe('validation', function () {
    it('throws ErrNoValuesProvider when no provider is registered and injection is required', function () {
      const di = new CaffeineIoC({ decorators: false })
      const compile = () =>
        compileChain(
          ctx(
            di,
            $i.value(cfg => cfg),
          ),
        )

      expect(compile).toThrow(ErrNoValuesProvider)
      // The injection site is what tells the reader which consumer needed the values.
      expect(compile).toThrow('Error resolving "Consumer"')
    })

    it('does not throw when optional and no provider is registered', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => compileChain(ctx(di, $i.optional($i.value(cfg => cfg))))).not.toThrow()
    })

    it('returns a resolver that yields undefined when optional and no provider is registered', function () {
      const di = new CaffeineIoC({ decorators: false })

      const resolver = compileChain(ctx(di, $i.optional($i.value(cfg => cfg))))
      expect(resolver()).toBeUndefined()
    })
  })

  describe('resolution', function () {
    it('resolves a string value via selector', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>({ host: 'localhost' })
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))
      await di.init()

      expect(di.get(Svc).host).toBe('localhost')
    })

    it('resolves a number value via selector', async function () {
      class Svc {
        constructor(readonly port: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ port: number }>({ port: 5432 })
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ port: number }>(cfg => cfg.port)]))
      await di.init()

      expect(di.get(Svc).port).toBe(5432)
    })

    it('resolves a boolean value via selector', async function () {
      class Svc {
        constructor(readonly enabled: boolean) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ enabled: boolean }>({ enabled: true })
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
      di.bindValuesProvider<Cfg>({ database: { host: 'db.local', port: 3306 } })
      di.bind(Svc, t =>
        t.toClass(Svc, [$i.value<Cfg>(cfg => cfg.database.host), $i.value<Cfg>(cfg => cfg.database.port)]),
      )
      await di.init()

      expect(di.get(Svc).host).toBe('db.local')
      expect(di.get(Svc).port).toBe(3306)
    })

    it('resolves from a class instance', async function () {
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
      di.bindValuesProvider(new AppCfg())
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
      di.bindValuesProvider<Cfg>({ a: 'alpha', b: 'beta', c: 'gamma' })
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
      di.bindValuesProvider<{ host: string }>({ host: 'optional-host' })
      di.bind(Svc, t => t.toClass(Svc, [$i.optional($i.value<{ host: string }>(cfg => cfg.host))]))
      await di.init()

      expect(di.get(Svc).host).toBe('optional-host')
    })
  })

  describe('error at init time', function () {
    it('throws ErrNoValuesProvider during init when provider is absent and injection is required', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }>(cfg => cfg.host)]))

      const init = di.init()

      await expect(init).rejects.toThrow(ErrNoValuesProvider)
      await expect(init).rejects.toThrow('Error resolving "Svc"')
    })
  })

  describe('string path access', function () {
    it('resolves a top-level key via string path', async function () {
      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>({ host: 'path-host' })
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
      di.bindValuesProvider<Cfg>({ database: { host: 'nested-host' } })
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
      di.bindValuesProvider<Cfg>({ a: { b: { c: 'deep' } } })
      di.bind(Svc, t => t.toClass(Svc, [$i.value('a.b.c')]))
      await di.init()

      expect(di.get(Svc).val).toBe('deep')
    })

    it('returns undefined for a missing intermediate key without throwing', async function () {
      class Svc {
        constructor(readonly val: unknown) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Record<string, unknown>>({})
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
      di.bindValuesProvider<{ host?: string }>({})
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host?: string }>(cfg => cfg.host, 'default-host')]))
      await di.init()

      expect(di.get(Svc).val).toBe('default-host')
    })

    it('string path form: returns default when path resolves to undefined', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<Record<string, unknown>>({})
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host', 'path-default')]))
      await di.init()

      expect(di.get(Svc).val).toBe('path-default')
    })

    it('does not use default when value is present and defined', async function () {
      class Svc {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string }>({ host: 'real-host' })
      di.bind(Svc, t => t.toClass(Svc, [$i.value('host', 'should-not-appear')]))
      await di.init()

      expect(di.get(Svc).val).toBe('real-host')
    })

    // `null` is a value the configuration holds, not an absence, so the default must not paper over it.
    it('returns a null value as is, not the default', async function () {
      class Svc {
        constructor(readonly val: string | null) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider<{ host: string | null }>({ host: null })
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string | null }>(cfg => cfg.host, 'default-host')]))
      await di.init()

      expect(di.get(Svc).val).toBeNull()
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

    it('applies a null default when no values are bound', async function () {
      class Svc {
        constructor(readonly val: string | null) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toClass(Svc, [$i.value<{ host: string }, string | null>(cfg => cfg.host, null)]))
      await di.init()

      expect(di.get(Svc).val).toBeNull()
    })
  })

  describe('getter-based values', function () {
    it('selector form invokes a getter on the values', async function () {
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
      di.bindValuesProvider(new AppConfig())
      di.bind(Svc, t => t.toClass(Svc, [$i.value<AppConfig>(cfg => cfg.host)]))
      await di.init()

      expect(di.get(Svc).host).toBe('computed-host')
    })

    it('string path form invokes a getter on the values', async function () {
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
      di.bindValuesProvider(new AppConfig())
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
      di.bindValuesProvider(new AppConfig())
      di.bind(Svc, t => t.toClass(Svc, [$i.value<AppConfig>(cfg => cfg.baseURL)]))
      await di.init()

      expect(di.get(Svc).url).toBe('https://example.com')
    })
  })

  describe('refresh and reload', function () {
    it('transient consumer sees a change made in place to the values between constructions', async function () {
      const config = { host: 'initial' }

      class Svc {
        constructor(readonly host: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bindValuesProvider(config)
      di.bind(Svc, t => t.toClass(Svc, [$i.value<typeof config>(c => c.host)]).lifetime(Scopes.TRANSIENT))
      await di.init()

      expect(di.get(Svc).host).toBe('initial')
      config.host = 'updated'
      expect(di.get(Svc).host).toBe('updated')
    })
  })
})
