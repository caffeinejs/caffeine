import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../load.js'
import { passthroughConfigSchema } from '../schema.js'
import { WATCH_DEBOUNCE_MS, pollDelay } from '../triggers.js'
import type { ConfigDefinition, ConfigSource } from '../types.js'
import { RecordingLogger } from './log.testkit.js'

function definition(sources: ConfigSource[]): ConfigDefinition {
  return { schema: passthroughConfigSchema, key: undefined, storeKey: undefined, sources, loadTimeoutMs: 30_000 }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('pollDelay', () => {
  it('spreads within 10 percent of the interval either way', () => {
    expect(pollDelay(1_000, 0, () => 0)).toBe(900)
    expect(pollDelay(1_000, 0, () => 0.5)).toBe(1_000)
    expect(pollDelay(1_000, 0, () => 0.999_999)).toBeCloseTo(1_100, 0)
  })

  it('doubles per consecutive failure, up to 8 times the interval', () => {
    const half = (): number => 0.5
    expect([0, 1, 2, 3, 4, 10].map(failures => pollDelay(1_000, failures, half))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ])
  })
})

describe('polling', () => {
  function polled(pollInterval: number) {
    const state = { loads: 0, fail: false, value: 0 }
    const source: ConfigSource = {
      name: 'remote',
      pollInterval,
      load: () => {
        state.loads++
        if (state.fail) {
          throw new Error('unreachable')
        }
        return [{ name: 'remote', data: { value: state.value } }]
      },
    }
    return { source, state }
  }

  it('reloads the source on its period, and applies what changed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { source, state } = polled(1_000)
    const store = await loadConfig(definition([source]))

    state.value = 1
    await vi.advanceTimersByTimeAsync(999)
    expect(state.loads).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(state.loads).toBe(2)
    expect((store.current as { value: number }).value).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.loads).toBe(3)
  })

  it('backs off while the source fails, and returns to its period once it recovers', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const logger = new RecordingLogger()
    const { source, state } = polled(1_000)
    await loadConfig(definition([source]), { logger })

    state.fail = true
    await vi.advanceTimersByTimeAsync(1_000) // fails once: next in 2 000
    await vi.advanceTimersByTimeAsync(2_000) // fails twice: next in 4 000
    expect(state.loads).toBe(3)
    expect(logger.at('warn').map(r => r.fields.nextAttemptMs)).toEqual([2_000, 4_000])

    state.fail = false
    await vi.advanceTimersByTimeAsync(4_000) // recovers: next in 1 000
    expect(state.loads).toBe(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.loads).toBe(5)
  })

  it('logs each armed trigger', async () => {
    const logger = new RecordingLogger()
    const { source } = polled(1_000)

    await loadConfig(definition([source]), { logger })

    expect(logger.at('debug').map(r => [r.msg, r.fields])).toEqual([
      ['config source polling', { source: 'remote', intervalMs: 1_000 }],
    ])
  })
})

describe('watching', () => {
  function watched() {
    const state = { loads: 0, value: 0, changed: undefined as (() => void) | undefined, stopped: 0 }
    const source: ConfigSource = {
      name: 'file',
      watch: changed => {
        state.changed = changed
        return () => {
          state.stopped++
        }
      },
      load: () => {
        state.loads++
        return [{ name: 'file', data: { value: state.value } }]
      },
    }
    return { source, state }
  }

  it('reloads once after a burst of changes settles', async () => {
    const { source, state } = watched()
    const store = await loadConfig(definition([source]))

    state.value = 1
    for (let i = 0; i < 5; i++) {
      state.changed?.()
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(state.loads).toBe(1)

    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS)
    expect(state.loads).toBe(2)
    expect((store.current as { value: number }).value).toBe(1)
  })

  it('reports a watcher that cannot start, and keeps the store working', async () => {
    const logger = new RecordingLogger()
    const source: ConfigSource = {
      name: 'file',
      watch: () => {
        throw new Error('no such directory')
      },
      load: () => [{ name: 'file', data: { value: 1 } }],
    }

    const store = await loadConfig(definition([source]), { logger })

    expect(store.current).toEqual({ value: 1 })
    expect(logger.at('warn')).toEqual([expect.objectContaining({ msg: 'config source failed' })])
  })
})

describe('triggers and the lifecycle', () => {
  it('holds no timer when every source is static', async () => {
    await loadConfig(definition([{ name: 'inline', load: () => [{ name: 'inline', data: { a: 1 } }] }]))

    expect(vi.getTimerCount()).toBe(0)
  })

  it('arms nothing until started, and only once', async () => {
    let watchers = 0
    const source: ConfigSource = {
      name: 'remote',
      pollInterval: 1_000,
      watch: () => {
        watchers++
        return () => undefined
      },
      load: () => [],
    }

    const store = await loadConfig(definition([source]), { start: false })
    expect(vi.getTimerCount()).toBe(0)

    store.start()
    store.start()

    expect(vi.getTimerCount()).toBe(1)
    expect(watchers).toBe(1)
  })

  it('clears every timer and stops every watcher on close', async () => {
    let stopped = 0
    const source: ConfigSource = {
      name: 'remote',
      pollInterval: 1_000,
      watch: () => () => {
        stopped++
      },
      load: () => [],
    }
    const store = await loadConfig(definition([source]))

    await store.close()

    expect(vi.getTimerCount()).toBe(0)
    expect(stopped).toBe(1)
  })

  // The next poll is armed when the previous one settles, and one can still be loading when the store closes.
  it('arms no further poll when the store closes while a poll is loading', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    let loads = 0
    const source: ConfigSource = {
      name: 'remote',
      pollInterval: 1_000,
      load: () => (++loads === 1 ? [] : new Promise<never>(() => undefined)),
    }
    const store = await loadConfig(definition([source]))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(loads).toBe(2)

    await store.close()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(loads).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  // A watcher can still report a change after close, before it has stopped.
  it('arms nothing for a change reported after close', async () => {
    let changed: (() => void) | undefined
    let loads = 0
    const source: ConfigSource = {
      name: 'file',
      watch: callback => {
        changed = callback
        return () => undefined
      },
      load: () => {
        loads++
        return []
      },
    }
    const store = await loadConfig(definition([source]))

    await store.close()
    changed?.()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS)
    expect(loads).toBe(1)
  })
})
