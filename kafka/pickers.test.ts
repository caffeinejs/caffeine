import { describe, expect, it } from 'vitest'

import type { KafkaMessage } from './config.js'
import type { KafkaContext } from './context.js'
import { compileArgs } from './pick_compiler.js'
import { $k } from './pickers.js'

const ctx = { marker: 'ctx' } as unknown as KafkaContext

function message(): KafkaMessage {
  return {
    key: 'k1',
    value: { id: 7 },
    topic: 'orders',
    partition: 3,
    offset: 42n,
    timestamp: 99n,
    headers: new Map([['trace', 'abc']]),
    headerEntries: [['trace', 'abc']],
    leaderEpoch: 0,
    metadata: {},
    commit: () => {},
    toJSON: () => ({}) as never,
  }
}

describe('kafka pickers', () => {
  it('produces correctly tagged descriptors', () => {
    expect($k.value()).toEqual({ type: 'kafka:value' })
    expect($k.key()).toEqual({ type: 'kafka:key' })
    expect($k.header('trace')).toEqual({ type: 'kafka:header', name: 'trace' })
    expect($k.message()).toEqual({ type: 'kafka:message' })
  })

  it('compiles the whole message by default (no params)', async () => {
    const msg = message()
    expect(await compileArgs(undefined)(msg, ctx)).toEqual([msg])
    expect(await compileArgs([])(msg, ctx)).toEqual([msg])
  })

  it('extracts the context via $k.context()', async () => {
    expect($k.context()).toEqual({ type: 'kafka:context' })
    const [got] = await compileArgs([$k.context()])(message(), ctx)
    expect(got).toBe(ctx)
  })

  it('extracts each declared part in order', async () => {
    const extract = compileArgs([
      $k.value(),
      $k.key(),
      $k.header('trace'),
      $k.topic(),
      $k.partition(),
      $k.offset(),
      $k.timestamp(),
      $k.headers(),
      $k.message(),
    ])
    const msg = message()
    const args = await extract(msg, ctx)

    expect(args[0]).toEqual({ id: 7 })
    expect(args[1]).toBe('k1')
    expect(args[2]).toBe('abc')
    expect(args[3]).toBe('orders')
    expect(args[4]).toBe(3)
    expect(args[5]).toBe(42n)
    expect(args[6]).toBe(99n)
    expect(args[7]).toBeInstanceOf(Map)
    expect(args[8]).toBe(msg)
  })

  it('supports a custom pick function', async () => {
    const extract = compileArgs([$k.pick(m => `${m.topic}:${m.partition}`)])
    expect(await extract(message(), ctx)).toEqual(['orders:3'])
  })

  it('awaits async custom picks', async () => {
    const extract = compileArgs([$k.pick(m => Promise.resolve(m.value), { async: true })])
    expect(await extract(message(), ctx)).toEqual([{ id: 7 }])
  })
})
