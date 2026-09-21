import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Application } from '../application.js'
import { InlineConfigSource } from '../config/index.js'
import { newConfiguration } from '../configuration.js'
import { $t } from '../schema/t.js'
import { LoggerBuilder } from './builder.js'
import { loggerConfigSchema, type LoggerConfig } from './config.js'
import { ConsoleLogger } from './console/console.js'
import { ErrInvalidLogLevel, ErrLoggerAlreadyConfigured } from './errors.js'
import { logToken } from './keys.js'
import { noopLogger } from './noop.js'

const schema = $t.Object({ logEnabled: $t.Boolean() })
type AppConfig = { logEnabled: boolean }
const kConfig = token<AppConfig>(Symbol('logger_builder.test.config'))

function appWithConfig(logEnabled: boolean) {
  const conf = newConfiguration(schema, kConfig).source(new InlineConfigSource({ logEnabled })).build()

  return new Application({ container: new CaffeineIoC({ decorators: false }), config: conf })
}

const sliceSchema = $t.Object({ log: loggerConfigSchema })
type SliceConfig = { log: LoggerConfig }
const kSlice = token<SliceConfig>(Symbol('logger_builder.test.slice'))

function appWithSlice(log: LoggerConfig) {
  const conf = newConfiguration(sliceSchema, kSlice).source(new InlineConfigSource({ log })).build()

  return new Application({ container: new CaffeineIoC({ decorators: false }), config: conf })
}

describe('LoggerBuilder', () => {
  it('is a bare ConsoleLogger when nothing was provided', () => {
    const built = new LoggerBuilder().logger

    expect(built).toBeInstanceOf(ConsoleLogger)
    expect(built.level).toBe('info')
  })

  it('is what was provided', () => {
    const provided = new ConsoleLogger({ level: 'debug' })
    const builder = new LoggerBuilder()
    builder.use(provided)

    expect(builder.logger).toBe(provided)
  })

  // One slot: a second logger is a mistake, not a replacement, so it fails loud rather than silently winning
  // or losing against the first.
  it('refuses a second logger', () => {
    const builder = new LoggerBuilder()
    builder.use(new ConsoleLogger())

    expect(() => builder.use(new ConsoleLogger())).toThrow(ErrLoggerAlreadyConfigured)
  })

  describe('disable', () => {
    // Disabling never means an absent logger — it means every write goes to the shared NoopLogger.
    it('is the NoopLogger once disabled', () => {
      const builder = new LoggerBuilder()
      builder.disable()

      expect(builder.logger).toBe(noopLogger)
    })

    it('re-enables, falling back to whatever .use()/the default would give, when called with false', () => {
      const provided = new ConsoleLogger()
      const builder = new LoggerBuilder()
      builder.use(provided).disable(true).disable(false)

      expect(builder.logger).toBe(provided)
    })

    it('applies on top of .use(), whichever order they were called in', () => {
      const provided = new ConsoleLogger()
      const builder = new LoggerBuilder()
      builder.disable(true).use(provided)

      expect(builder.logger).toBe(noopLogger)
    })
  })
})

describe('Application integration', () => {
  it('answers `log` and `logToken()` with a bare ConsoleLogger when .logger() is never called', async () => {
    const app = new Application({ container: new CaffeineIoC({ decorators: false }) })

    expect(app.log).toBeInstanceOf(ConsoleLogger)

    await app.ready()

    expect(app.container.get(logToken())).toBe(app.log)
  })

  // LoggerBuilder is a Feature again: `.logger(...)` is deferred to `ready()`, exactly like `.shutdown(...)`,
  // so `.log` still holds the eager default immediately after the call and only reflects it once `ready()`
  // has run.
  it('defers .logger() to ready(), not the call itself', async () => {
    const app = new Application({ container: new CaffeineIoC({ decorators: false }) })
    const provided = new ConsoleLogger({ level: 'debug' })

    app.logger(l => l.use(provided))

    expect(app.log).not.toBe(provided)

    await app.ready()

    expect(app.log).toBe(provided)
    expect(app.container.get(logToken())).toBe(provided)
  })

  it('takes the logger from ApplicationOptions.logger, eagerly, before ready()', () => {
    const provided = new ConsoleLogger({ level: 'warn' })
    const app = new Application({ container: new CaffeineIoC({ decorators: false }), logger: provided })

    expect(app.log).toBe(provided)
  })

  // false disables entirely — never an absent logger.
  it('disables via ApplicationOptions.logger: false', async () => {
    const app = new Application({ container: new CaffeineIoC({ decorators: false }), logger: false })

    expect(app.log).toBe(noopLogger)

    await app.ready()

    expect(app.container.get(logToken())).toBe(noopLogger)
  })

  // The reason `.logger()` had to become a Feature again: `.disable(c.logEnabled)` reads a real, resolved
  // configuration value, not a schema default — impossible before config resolves, which only happens inside
  // `ready()`.
  it('reads the resolved configuration, not a pre-resolution default', async () => {
    const app = appWithConfig(false)
    app.logger((b, { config }) => b.disable(config.logEnabled === false))

    await app.ready()

    expect(app.log).toBe(noopLogger)
  })

  it('stays enabled when the resolved configuration says so', async () => {
    const app = appWithConfig(true)
    app.logger((b, { config }) => b.disable(config.logEnabled === false))

    await app.ready()

    expect(app.log).not.toBe(noopLogger)
  })

  // Every other configurable feature takes a whole node with `config(...)`; the logger took settings one at a
  // time, so an application had to restate the mapping instead of composing `loggerConfigSchema`.
  describe('config(node)', () => {
    it('reads the level and the enabled flag off the node', async () => {
      const app = appWithSlice({ level: 'debug', enabled: true })
      app.logger((b, { config }) => b.config(config.log))

      await app.ready()

      expect(app.log).not.toBe(noopLogger)
      expect(app.log.level).toBe('debug')
    })

    // The tree states `enabled`; the builder holds `disabled`. The mapping is the feature's, not the caller's.
    it('disables on `enabled: false`', async () => {
      const app = appWithSlice({ enabled: false })
      app.logger((b, { config }) => b.config(config.log))

      await app.ready()

      expect(app.log).toBe(noopLogger)
    })

    // A fluent method is the last word: the node is what the environment offered, and code that names the same
    // setting alongside it has overridden it deliberately.
    it('loses to a fluent method naming the same setting', async () => {
      const app = appWithSlice({ level: 'error', enabled: false })
      app.logger((b, { config }) => b.config(config.log).level('trace').disable(false))

      await app.ready()

      expect(app.log).not.toBe(noopLogger)
      expect(app.log.level).toBe('trace')
    })

    // Absence has to keep meaning "nobody set this", or an unset key in the tree would silently beat the code.
    it('leaves what the node does not name to the builder', async () => {
      const app = appWithSlice({ level: 'warn' })
      app.logger((b, { config }) => b.config(config.log))

      await app.ready()

      expect(app.log).not.toBe(noopLogger)
      expect(app.log.level).toBe('warn')
    })
  })

  // The level is the one setting that has to come from the environment. Without this, an application wanting
  // debug logs has to construct its whole logger by hand just to pass a level to it.
  describe('level', () => {
    it('sets the level on the default logger', async () => {
      const app = new Application({ container: new CaffeineIoC({ decorators: false }) })
      app.logger(l => l.level('debug'))

      await app.ready()

      expect(app.log.level).toBe('debug')
    })

    it('sets the level on a logger that was provided', async () => {
      const provided = new ConsoleLogger({ level: 'warn' })
      const app = new Application({ container: new CaffeineIoC({ decorators: false }) })
      app.logger(l => l.use(provided).level('trace'))

      await app.ready()

      expect(provided.level).toBe('trace')
    })

    it('reads the resolved configuration, like every other setting', async () => {
      const app = appWithConfig(true)
      app.logger((l, { config }) => l.level(config.logEnabled ? 'debug' : 'error'))

      await app.ready()

      expect(app.log.level).toBe('debug')
    })

    // `noopLogger` is one shared instance. A level written to it would follow every other application in the
    // process, including ones that never disabled anything.
    it('leaves the NoopLogger alone when disabled', async () => {
      const app = new Application({ container: new CaffeineIoC({ decorators: false }) })
      app.logger(l => l.disable().level('debug'))

      await app.ready()

      expect(app.log).toBe(noopLogger)
      expect(noopLogger.level).toBe('silent')
    })

    it('surfaces a level the logger refuses, out of ready()', async () => {
      const app = new Application({ container: new CaffeineIoC({ decorators: false }) })
      app.logger(l => l.level('verbose'))

      await expect(app.ready()).rejects.toThrow(ErrInvalidLogLevel)
    })
  })

  it('refuses a second .use() across two .logger() calls, surfaced when ready() runs them', async () => {
    const app = new Application({ container: new CaffeineIoC({ decorators: false }) })

    app.logger(l => l.use(new ConsoleLogger()))
    app.logger(l => l.use(new ConsoleLogger()))

    await expect(app.ready()).rejects.toThrow(ErrLoggerAlreadyConfigured)
  })
})
