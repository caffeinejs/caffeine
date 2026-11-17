import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/application/logger'
import { describe, expect, it } from 'vitest'

import { createWebApplication } from '../application.js'
import { Controller, Get } from '../index.js'
import { node } from '../platform/node/index.js'

type Record_ = { severity: string; args: unknown[]; bindings: Bindings }

/** A `Logger` that keeps what it was asked to write, so what the application writes through it can be read back. */
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

describe('a Caffeine Logger as the application logger', () => {
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
    const app = createWebApplication({ adapter: node(), logger: recorder as unknown as Logger })
    await app.bootstrap()

    const res = await app.request('/logged/ping')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
