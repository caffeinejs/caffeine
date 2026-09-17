import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/std/logger'
import { ConsoleLogger } from '@caffeinejs/std/logger/console'
import fastify, { type FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'

import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'

type Record_ = { severity: string; args: unknown[]; bindings: Bindings }

/** A `Logger` that keeps what it was asked to write, so what Fastify routes through it can be read back. */
class Recorder implements Logger {
  level = 'info'
  readonly levels: LevelMapping = {
    values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
    labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  }

  readonly trace = this.#record('trace')
  readonly debug = this.#record('debug')
  readonly info = this.#record('info')
  readonly warn = this.#record('warn')
  readonly error = this.#record('error')
  readonly fatal = this.#record('fatal')
  readonly silent = this.#record('silent')

  readonly records: Record_[]
  readonly #bindings: Bindings

  constructor(records: Record_[] = [], bindings: Bindings = {}) {
    this.records = records
    this.#bindings = bindings
  }

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return this.#bindings
  }

  child(bindings: Bindings): Logger {
    return new Recorder(this.records, { ...this.#bindings, ...bindings })
  }

  flush(): void {
    // Nothing is buffered.
  }

  #record(severity: string): LogFn {
    return (...args: unknown[]): void => {
      this.records.push({ severity, args, bindings: this.#bindings })
    }
  }
}

describe('a Caffeine Logger as Fastify’s server logger', () => {
  // The reason the contract is shaped the way it is. If this stops compiling, `Logger` has drifted from
  // `FastifyBaseLogger` and an application can no longer hand its own logger to the server.
  it('is accepted where Fastify asks for its own logger type', () => {
    const log: FastifyBaseLogger = new ConsoleLogger()

    expect(typeof log.child).toBe('function')
    expect(typeof log.info).toBe('function')
    expect(log.level).toBe('info')
  })

  it('boots a web application and serves through it', async () => {
    @Controller('/logged')
    class LoggedController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [LoggedController]

    const recorder = new Recorder()
    const app = createWebApplication(fastifyAdapterFactory(fastify({ loggerInstance: recorder as any })))
    await app.ready()

    const res = await app.fetch('/logged/ping')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // Fastify derives a per-request child from whatever instance it was given. A wrapper whose `child` did not
  // forward would leave `req.log` writing nowhere, which is the failure this catches.
  it('routes the per-request logger back to the implementation', async () => {
    @Controller('/logging')
    class LoggingController {
      @Get('/write')
      write() {
        return { ok: true }
      }
    }

    void [LoggingController]

    const recorder = new Recorder()
    const instance = fastify({ loggerInstance: recorder as any })

    instance.addHook('onRequest', (req, _reply, done) => {
      req.log.warn({ from: 'request' }, 'per-request record')
      done()
    })

    const app = createWebApplication(fastifyAdapterFactory(instance))
    await app.ready()

    await app.fetch('/logging/write')

    const written = recorder.records.find(record => record.args[1] === 'per-request record')

    expect(written).toBeDefined()
    expect(written?.severity).toBe('warn')
    expect(written?.args[0]).toEqual({ from: 'request' })
    // The child Fastify derived carries the request id it stamped, so the record came through `child`.
    expect(written?.bindings).toHaveProperty('reqId')
  })

  // Without this the framework builds its server with no logger at all, so an application that configured one
  // logs through it while its own HTTP server logs through a second, unrelated one.
  it('builds its own server with the application’s logger, with no Fastify instance supplied', async () => {
    const recorder = new Recorder()
    const app = createWebApplication({ logger: recorder as unknown as Logger })
    await app.ready()

    app.instance.log.error({ code: 'x' }, 'through the application logger')

    const written = recorder.records.find(record => record.args[1] === 'through the application logger')

    expect(written).toBeDefined()
    expect(written?.severity).toBe('error')
  })

  it('derives the per-request logger from it too', async () => {
    @Controller('/wired')
    class WiredController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [WiredController]

    const recorder = new Recorder()
    const app = createWebApplication({ logger: recorder as unknown as Logger })

    app.instance.addHook('onRequest', (req, _reply, done) => {
      req.log.warn({ from: 'request' }, 'wired per-request record')
      done()
    })

    await app.ready()
    await app.fetch('/wired/ping')

    const written = recorder.records.find(record => record.args[1] === 'wired per-request record')

    expect(written).toBeDefined()
    expect(written?.bindings).toHaveProperty('reqId')
  })

  // Fastify derives its own child of the logger while it is constructed, and a child keeps the level it was born
  // with — so without the adapter pushing the resolved level onto it, `.level('debug')` would govern every
  // logger except the server's own, which is the one a `LOG_LEVEL=debug` is usually reaching for.
  it('takes the level the logger feature resolved, after the server was built', async () => {
    @Controller('/levelled')
    class LevelledController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [LevelledController]

    const app = createWebApplication()
    app.logger(l => l.level('debug'))

    let perRequestLevel: string | undefined
    app.instance.addHook('onRequest', (req, _reply, done) => {
      perRequestLevel = req.log.level
      done()
    })

    await app.ready()
    await app.fetch('/levelled/ping')

    expect(app.instance.log.level).toBe('debug')
    expect(perRequestLevel).toBe('debug')
  })

  // Handing the server a logger must not change what an application prints: Fastify logs two lines per request
  // as soon as it has one, which every existing application would suddenly start emitting.
  it('does not turn Fastify’s automatic request logging on', async () => {
    @Controller('/quiet')
    class QuietController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void [QuietController]

    const recorder = new Recorder()
    const app = createWebApplication({ logger: recorder as unknown as Logger })
    await app.ready()

    await app.fetch('/quiet/ping')

    expect(recorder.records.map(record => record.args[1])).not.toContain('incoming request')
    expect(recorder.records.map(record => record.args[1])).not.toContain('request completed')
  })

  it('routes the server logger back to the implementation', async () => {
    const recorder = new Recorder()
    const instance = fastify({ loggerInstance: recorder as any })

    const app = createWebApplication(fastifyAdapterFactory(instance))
    await app.ready()

    instance.log.error({ code: 'x' }, 'server record')

    const written = recorder.records.find(record => record.args[1] === 'server record')

    expect(written).toBeDefined()
    expect(written?.severity).toBe('error')
  })
})
