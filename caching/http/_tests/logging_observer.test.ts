import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/std/logger'
import { describe, expect, it } from 'vitest'

import { loggingCacheObserver } from '../logging_observer.js'
import type { CacheRoute } from '../observer.js'

type Written = { severity: string; args: unknown[] }

/** A `Logger` that keeps what it was asked to write. */
class Recorder implements Logger {
  level = 'trace'
  readonly levels: LevelMapping = {
    values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
    labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  }

  readonly written: Written[] = []

  readonly trace = this.#record('trace')
  readonly debug = this.#record('debug')
  readonly info = this.#record('info')
  readonly warn = this.#record('warn')
  readonly error = this.#record('error')
  readonly fatal = this.#record('fatal')
  readonly silent = this.#record('silent')

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return {}
  }

  child(): Logger {
    return this
  }

  flush(): void {
    // Nothing is buffered.
  }

  #record(severity: string): LogFn {
    return (...args: unknown[]): void => {
      this.written.push({ severity, args })
    }
  }
}

const route: CacheRoute = Object.freeze({ method: 'GET', url: '/pets/:id', handler: 'PetsController.find' })

describe('loggingCacheObserver', () => {
  it('writes at debug unless told otherwise', () => {
    const log = new Recorder()
    loggingCacheObserver(log).onBypass!({ route, reason: 'authorization' })
    loggingCacheObserver(log, { level: 'info' }).onBypass!({ route, reason: 'authorization' })

    expect(log.written.map(w => w.severity)).toEqual(['debug', 'info'])
  })

  it('writes the event as structured fields, with the message apart', () => {
    const log = new Recorder()
    loggingCacheObserver(log).onMiss!({ route, segment: 'pets', key: '%2Fpets%2F1', reason: 'absent' })

    const [fields, message] = log.written[0].args

    expect(message).toBe('cache miss')
    expect(fields).toMatchObject({ route, segment: 'pets', reason: 'absent' })
  })

  // A key carries the query string and every Vary header value — a bearer token when a route varies on
  // Authorization. A log is not where that belongs unless someone asked for it.
  it('leaves the cache key out of every record by default', () => {
    const log = new Recorder()
    const observer = loggingCacheObserver(log)

    observer.onHit!({ route, key: 'secret', revalidated: false, ageSeconds: 1 })
    observer.onMiss!({ route, key: 'secret', reason: 'absent' })
    observer.onStore!({ route, key: 'secret', bytes: 10, ttlSeconds: 60 })
    observer.onInvalidate!({ route, scope: 'keys', keys: ['secret', 'other'] })

    for (const { args } of log.written) {
      expect(args[0]).not.toHaveProperty('key')
      expect(args[0]).not.toHaveProperty('keys')
    }
    expect(log.written[3].args[0]).toMatchObject({ scope: 'keys', keyCount: 2 })
  })

  it('writes the cache key when includeKeys is set', () => {
    const log = new Recorder()
    const observer = loggingCacheObserver(log, { includeKeys: true })

    observer.onHit!({ route, key: 'k1', revalidated: true, ageSeconds: 1 })
    observer.onInvalidate!({ route, scope: 'keys', keys: ['k1', 'k2'] })

    expect(log.written[0].args[0]).toMatchObject({ key: 'k1', revalidated: true })
    expect(log.written[1].args[0]).toMatchObject({ keys: ['k1', 'k2'], keyCount: 2 })
  })

  it('records a segment clear by its segment', () => {
    const log = new Recorder()
    loggingCacheObserver(log).onInvalidate!({ route, scope: 'segment', segment: 'products' })

    expect(log.written[0].args).toEqual([{ route, segment: 'products', scope: 'segment' }, 'cache invalidate'])
  })
})
