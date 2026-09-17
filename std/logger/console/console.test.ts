import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrInvalidLogLevel } from '../errors.js'
import { ConsoleLogger } from './console.js'

function spies() {
  return {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('level filtering', () => {
  // The level is the only thing standing between a debug-heavy service and its production log bill, so a
  // record below it must not reach console at all — not be written and filtered downstream.
  it('writes nothing below the configured level', () => {
    const console_ = spies()
    const log = new ConsoleLogger({ level: 'warn' })

    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')

    expect(console_.debug).not.toHaveBeenCalled()
    expect(console_.info).not.toHaveBeenCalled()
    expect(console_.warn).toHaveBeenCalledTimes(1)
    expect(console_.error).toHaveBeenCalledTimes(2)
  })

  it('defaults to info', () => {
    const console_ = spies()
    const log = new ConsoleLogger()

    log.debug('d')
    log.info('i')

    expect(console_.debug).not.toHaveBeenCalled()
    expect(console_.info).toHaveBeenCalledTimes(1)
  })

  // `silent` is a severity by name, not a level: it exists so a call site can be muted without the caller
  // reasoning about where the threshold currently sits.
  it('writes nothing through silent, even at the lowest level', () => {
    const console_ = spies()
    const log = new ConsoleLogger({ level: 'trace' })

    log.silent({ a: 1 }, 'never')

    expect(console_.debug).not.toHaveBeenCalled()
    expect(console_.info).not.toHaveBeenCalled()
    expect(console_.warn).not.toHaveBeenCalled()
    expect(console_.error).not.toHaveBeenCalled()
  })

  it('follows the level after it is reassigned', () => {
    const console_ = spies()
    const log = new ConsoleLogger({ level: 'error' })

    log.info('before')
    log.level = 'info'
    log.info('after')

    expect(console_.info).toHaveBeenCalledTimes(1)
    expect(console_.info.mock.calls[0]?.[0]).toContain('after')
  })
})

describe('call shapes', () => {
  // Both Pino call shapes have to reach the same record, because the whole point of matching that surface is
  // that code written against one logger reads the same against another.
  it('takes the fields first and the message second', () => {
    const console_ = spies()

    new ConsoleLogger().info({ orderID: 7 }, 'order created')

    expect(console_.info).toHaveBeenCalledTimes(1)
    const [line, payload] = console_.info.mock.calls[0] as [string, unknown]
    expect(line).toContain('INFO')
    expect(line).toContain('order created')
    expect(payload).toEqual({ orderID: 7 })
  })

  it('takes a bare message, and passes no payload when there are no fields', () => {
    const console_ = spies()

    new ConsoleLogger().info('plain')

    expect(console_.info.mock.calls[0]).toHaveLength(1)
    expect(console_.info.mock.calls[0]?.[0]).toContain('plain')
  })

  it('formats the message with the trailing arguments', () => {
    const console_ = spies()

    new ConsoleLogger().info({ a: 1 }, 'hit %s in %dms', 'db', 12)

    expect(console_.info.mock.calls[0]?.[0]).toContain('hit db in 12ms')
  })

  // Pino writes a non-string message rather than discarding it, and an untyped caller reaching this path meant
  // to say something. Dropping it silently would lose the only content of the record.
  it('writes a non-string message instead of dropping it', () => {
    const console_ = spies()

    new ConsoleLogger().info({ a: 1 }, 42 as unknown as string)

    expect(console_.info.mock.calls[0]?.[0]).toContain('42')
  })

  it('still writes no message when only fields were given', () => {
    const console_ = spies()

    new ConsoleLogger().info({ a: 1 })

    const [line, payload] = console_.info.mock.calls[0] as [string, unknown]
    expect(line).toMatch(/INFO $/)
    expect(payload).toEqual({ a: 1 })
  })

  // An Error has no enumerable own properties, so spreading it produces `{}`. Losing the one thing the caller
  // wanted to report is worse than any formatting choice, so it is carried explicitly.
  it('keeps an error passed on its own, and uses its message', () => {
    const console_ = spies()
    const err = new Error('boom')

    new ConsoleLogger().error(err)

    const [line, payload] = console_.error.mock.calls[0] as [string, { err: Error }]
    expect(line).toContain('boom')
    expect(payload.err).toBe(err)
  })

  it('routes each severity to its console method', () => {
    const console_ = spies()
    const log = new ConsoleLogger({ level: 'trace' })

    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')

    expect(console_.debug).toHaveBeenCalledTimes(2)
    expect(console_.info).toHaveBeenCalledTimes(1)
    expect(console_.warn).toHaveBeenCalledTimes(1)
    expect(console_.error).toHaveBeenCalledTimes(2)
  })
})

describe('child', () => {
  it('merges its bindings into every record and inherits the level', () => {
    const console_ = spies()
    const log = new ConsoleLogger({ level: 'debug', bindings: { app: 'shop' } })

    const child = log.child({ svc: 'catalog' })
    child.debug({ id: 1 }, 'hit')

    expect(child.level).toBe('debug')
    expect(console_.debug.mock.calls[0]?.[1]).toEqual({ app: 'shop', svc: 'catalog', id: 1 })
  })

  it('takes a level of its own when one is given', () => {
    const console_ = spies()

    const child = new ConsoleLogger({ level: 'debug' }).child({}, { level: 'error' })
    child.debug('quiet')

    expect(child.level).toBe('error')
    expect(console_.debug).not.toHaveBeenCalled()
  })

  // Fastify derives its per-request child with the route's `logLevel`, which is `''` unless the route set one.
  // Treating that as a level rather than as "none given" makes every request through a wired server throw.
  it('inherits the parent level when it is handed an empty one', () => {
    const child = new ConsoleLogger({ level: 'warn' }).child({}, { level: '' })

    expect(child.level).toBe('warn')
  })

  // A child that wrote back into its parent's bindings would leak one request's fields into the next.
  it('does not change its parent', () => {
    const console_ = spies()
    const log = new ConsoleLogger()

    log.child({ svc: 'catalog' })
    log.info('parent')

    expect(console_.info.mock.calls[0]).toHaveLength(1)
  })
})

describe('invalid level', () => {
  it('throws from the constructor', () => {
    expect(() => new ConsoleLogger({ level: 'verbose' })).toThrow(ErrInvalidLogLevel)
  })

  it('throws from the setter, leaving the level as it was', () => {
    const log = new ConsoleLogger({ level: 'warn' })

    expect(() => {
      log.level = 'verbose'
    }).toThrow(ErrInvalidLogLevel)
    expect(log.level).toBe('warn')
  })
})

describe('isLevelEnabled', () => {
  it('agrees with the level filter', () => {
    const log = new ConsoleLogger({ level: 'warn' })

    expect(log.isLevelEnabled('trace')).toBe(false)
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('warn')).toBe(true)
    expect(log.isLevelEnabled('error')).toBe(true)
  })

  it('is false for an unknown level, rather than throwing', () => {
    expect(new ConsoleLogger().isLevelEnabled('verbose')).toBe(false)
  })
})

describe('bindings', () => {
  it('returns what the logger carries', () => {
    const log = new ConsoleLogger({ bindings: { app: 'shop' } })

    expect(log.bindings()).toEqual({ app: 'shop' })
  })

  // A caller mutating the returned object must not reach into the logger's own state.
  it('returns a copy, not the live bindings', () => {
    const log = new ConsoleLogger({ bindings: { app: 'shop' } })

    const copy = log.bindings()
    copy.app = 'tampered'

    expect(log.bindings()).toEqual({ app: 'shop' })
  })
})

describe('levels', () => {
  it('names the six real levels, silent excluded', () => {
    const log = new ConsoleLogger()

    expect(log.levels.values).toEqual({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 })
    expect(log.levels.labels).toEqual({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' })
  })
})

describe('flush', () => {
  it('does nothing — console has already written synchronously', () => {
    expect(() => new ConsoleLogger().flush()).not.toThrow()
  })
})
