import { describe, it, expect, vi } from 'vitest'

import { GracefulShutdown } from './shutdown.js'
import { type SignalDispatcher, type ShutdownSignal, noopSignalDispatcher } from './signals.js'

/** A dispatcher that records everything instead of touching the real process. */
class FakeDispatcher implements SignalDispatcher {
  readonly handlers = new Map<ShutdownSignal, Set<() => void>>()
  readonly warnings: string[] = []
  readonly errors: unknown[] = []
  exitedWith: number | undefined
  exitCode: number | undefined

  constructor(readonly pid: number | undefined = 1234) {}

  on(signal: ShutdownSignal, handler: () => void): void {
    const set = this.handlers.get(signal) ?? new Set()
    set.add(handler)
    this.handlers.set(signal, set)
  }

  off(signal: ShutdownSignal, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler)
  }

  exit(code: number): void {
    this.exitedWith = code
  }

  setExitCode(code: number): void {
    this.exitCode = code
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  error(_message: string, error: unknown): void {
    this.errors.push(error)
  }

  send(signal: ShutdownSignal): void {
    for (const handler of this.handlers.get(signal) ?? []) {
      handler()
    }
  }

  count(signal: ShutdownSignal): number {
    return this.handlers.get(signal)?.size ?? 0
  }
}

describe('GracefulShutdown', () => {
  it('installs one handler per signal and removes them all', () => {
    const dispatcher = new FakeDispatcher(100)
    const shutdown = new GracefulShutdown(() => Promise.resolve(), dispatcher)

    shutdown.install(['SIGTERM', 'SIGINT'])

    expect(dispatcher.count('SIGTERM')).toBe(1)
    expect(dispatcher.count('SIGINT')).toBe(1)

    shutdown.uninstall()

    expect(dispatcher.count('SIGTERM')).toBe(0)
    expect(dispatcher.count('SIGINT')).toBe(0)
  })

  it('installs nothing when signals are disabled', () => {
    const dispatcher = new FakeDispatcher(100)

    new GracefulShutdown(() => Promise.resolve(), dispatcher).install(false)

    expect(dispatcher.handlers.size).toBe(0)
  })

  it('does not install the same signal twice', () => {
    const dispatcher = new FakeDispatcher(100)
    const shutdown = new GracefulShutdown(() => Promise.resolve(), dispatcher)

    shutdown.install(['SIGTERM'])
    shutdown.install(['SIGTERM'])

    expect(dispatcher.count('SIGTERM')).toBe(1)
  })

  it('closes once and records a clean exit code without terminating', async () => {
    const dispatcher = new FakeDispatcher(100)
    const close = vi.fn(() => Promise.resolve())
    const shutdown = new GracefulShutdown(close, dispatcher)

    shutdown.install(['SIGTERM'])
    dispatcher.send('SIGTERM')
    await vi.waitFor(() => expect(dispatcher.exitCode).toBe(0))

    expect(close).toHaveBeenCalledTimes(1)
    // Never terminates on the happy path: that would truncate whatever stdout had buffered.
    expect(dispatcher.exitedWith).toBeUndefined()
    expect(shutdown.shuttingDown).toBe(true)
  })

  it('reports a failed shutdown and exits non-zero', async () => {
    const dispatcher = new FakeDispatcher(100)
    const failure = new Error('dispose blew up')
    const shutdown = new GracefulShutdown(() => Promise.reject(failure), dispatcher)

    shutdown.install(['SIGTERM'])
    dispatcher.send('SIGTERM')
    await vi.waitFor(() => expect(dispatcher.exitCode).toBe(1))

    expect(dispatcher.errors).toEqual([failure])
  })

  it('exits immediately on a second signal, with the conventional code', () => {
    const dispatcher = new FakeDispatcher(100)
    const close = vi.fn(() => new Promise<void>(() => {}))
    const shutdown = new GracefulShutdown(close, dispatcher)

    shutdown.install(['SIGTERM', 'SIGINT'])

    dispatcher.send('SIGTERM')
    expect(dispatcher.exitedWith).toBeUndefined()

    dispatcher.send('SIGTERM')
    expect(dispatcher.exitedWith).toBe(143)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses the signal that arrived second for the exit code', () => {
    const dispatcher = new FakeDispatcher(100)
    const shutdown = new GracefulShutdown(() => new Promise<void>(() => {}), dispatcher)

    shutdown.install(['SIGTERM', 'SIGINT'])
    dispatcher.send('SIGTERM')
    dispatcher.send('SIGINT')

    expect(dispatcher.exitedWith).toBe(130)
  })

  it('warns about signal delivery only when running as PID 1', () => {
    const asInit = new FakeDispatcher(1)
    new GracefulShutdown(() => Promise.resolve(), asInit).install(['SIGTERM'])
    expect(asInit.warnings[0]).toContain('Running as PID 1')

    const normal = new FakeDispatcher(4321)
    new GracefulShutdown(() => Promise.resolve(), normal).install(['SIGTERM'])
    expect(normal.warnings).toEqual([])

    // A runtime with no process id at all must not be mistaken for an init process.
    const runtimeless = new FakeDispatcher(undefined)
    new GracefulShutdown(() => Promise.resolve(), runtimeless).install(['SIGTERM'])
    expect(runtimeless.warnings).toEqual([])
  })

  it('is inert on a runtime without signals', async () => {
    const close = vi.fn(() => Promise.resolve())
    const shutdown = new GracefulShutdown(close, noopSignalDispatcher)

    // The point is that none of this throws where `process` does not exist.
    shutdown.install(['SIGTERM'])
    shutdown.uninstall()

    expect(close).not.toHaveBeenCalled()
    await Promise.resolve()
  })
})
