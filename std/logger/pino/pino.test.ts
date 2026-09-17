import { Writable } from 'node:stream'

import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'

import { PinoLogger } from './pino.js'

/** Collects what Pino writes, so the records can be read back as the JSON they are on the wire. */
function sink() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString())
      callback()
    },
  })

  return {
    stream,
    records: (): Array<Record<string, unknown>> =>
      lines
        .join('')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>),
  }
}

describe('PinoLogger', () => {
  it('builds an instance from options', () => {
    expect(new PinoLogger({ level: 'debug' }).level).toBe('debug')
  })

  it('defaults to whatever Pino defaults to', () => {
    expect(new PinoLogger().level).toBe('info')
  })

  // An application that built its own Pino — a transport, a destination, serializers — must get that
  // instance, not a second one built from it.
  it('uses a supplied instance rather than building another', () => {
    const destination = sink()
    const instance = pino({ level: 'debug' }, destination.stream)

    new PinoLogger(instance).debug({ a: 1 }, 'through the supplied instance')

    expect(destination.records()).toHaveLength(1)
    expect(destination.records()[0]).toMatchObject({ a: 1, msg: 'through the supplied instance' })
  })

  it('writes the fields and the message as one record', () => {
    const destination = sink()

    new PinoLogger(pino({ level: 'info' }, destination.stream)).info({ orderID: 7 }, 'order created')

    const [record] = destination.records()
    expect(record).toMatchObject({ orderID: 7, msg: 'order created', level: 30 })
  })

  it('carries a child’s bindings into every record it writes', () => {
    const destination = sink()

    const child = new PinoLogger(pino({ level: 'info' }, destination.stream)).child({ svc: 'catalog' })
    child.info('hit')

    expect(destination.records()[0]).toMatchObject({ svc: 'catalog', msg: 'hit' })
  })

  it('takes a level of its own for a child', () => {
    const destination = sink()

    const child = new PinoLogger(pino({ level: 'info' }, destination.stream)).child({}, { level: 'error' })
    child.info('quiet')
    child.error('loud')

    expect(destination.records()).toHaveLength(1)
    expect(destination.records()[0]).toMatchObject({ msg: 'loud' })
  })

  it('reads and writes the level through to Pino', () => {
    const instance = pino({ level: 'info' })
    const log = new PinoLogger(instance)

    log.level = 'trace'

    expect(instance.level).toBe('trace')
    expect(log.level).toBe('trace')
  })
})

describe('isLevelEnabled', () => {
  it('forwards to Pino', () => {
    const log = new PinoLogger({ level: 'warn' })

    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('warn')).toBe(true)
  })
})

describe('bindings', () => {
  it('returns what a child carries', () => {
    const child = new PinoLogger({ level: 'info' }).child({ svc: 'catalog' })

    expect(child.bindings()).toMatchObject({ svc: 'catalog' })
  })
})

describe('levels', () => {
  it('forwards Pino’s own level mapping', () => {
    const log = new PinoLogger()

    expect(log.levels.values).toMatchObject({ info: 30, error: 50 })
    expect(log.levels.labels).toMatchObject({ 30: 'info', 50: 'error' })
  })
})

describe('flush', () => {
  it('forwards to Pino, callback and all', () => {
    const instance = pino({ level: 'info' })
    const flushSpy = vi.spyOn(instance, 'flush')
    const cb = vi.fn()

    new PinoLogger(instance).flush(cb)

    expect(flushSpy).toHaveBeenCalledWith(cb)
  })
})
