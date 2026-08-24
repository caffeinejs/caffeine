import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  WARNING_TYPE,
  detectSignalDispatcher,
  hasProcessSignals,
  noopSignalDispatcher,
  processSignalDispatcher,
} from './signals.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hasProcessSignals', () => {
  it('is true on a runtime with a signal-capable process', () => {
    expect(hasProcessSignals()).toBe(true)
  })

  it('is false where there is no process at all', () => {
    const host = globalThis as { process?: unknown }
    const original = host.process

    try {
      delete host.process
      expect(hasProcessSignals()).toBe(false)
    } finally {
      host.process = original
    }
  })
})

describe('detectSignalDispatcher', () => {
  it('returns the same dispatcher every time', () => {
    expect(detectSignalDispatcher()).toBe(detectSignalDispatcher())
  })
})

describe('processSignalDispatcher', () => {
  it('registers and removes handlers on the host process', () => {
    const dispatcher = processSignalDispatcher()
    const before = process.listenerCount('SIGHUP')
    const handler = (): void => {}

    dispatcher.on('SIGHUP', handler)
    expect(process.listenerCount('SIGHUP')).toBe(before + 1)

    dispatcher.off('SIGHUP', handler)
    expect(process.listenerCount('SIGHUP')).toBe(before)
  })

  it('records an exit code rather than terminating', () => {
    const dispatcher = processSignalDispatcher()
    const original = process.exitCode

    try {
      dispatcher.setExitCode(0)
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = original
    }
  })

  it('tags warnings so callers can filter on them', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})

    processSignalDispatcher().warn('something to know about')

    expect(emit).toHaveBeenCalledWith('something to know about', WARNING_TYPE)
  })

  it('reports the host process id', () => {
    expect(processSignalDispatcher().pid).toBe(process.pid)
  })
})

describe('noopSignalDispatcher', () => {
  it('swallows every operation without throwing', () => {
    const handler = (): void => {}

    expect(() => {
      noopSignalDispatcher.on('SIGTERM', handler)
      noopSignalDispatcher.off('SIGTERM', handler)
      noopSignalDispatcher.exit(1)
      noopSignalDispatcher.setExitCode(0)
      noopSignalDispatcher.warn('ignored')
      noopSignalDispatcher.error('ignored', new Error('ignored'))
    }).not.toThrow()

    expect(noopSignalDispatcher.pid).toBeUndefined()
  })
})
