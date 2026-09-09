import { CaffeineIoC, type OnDestroy } from '@caffeinejs/di'
import { describe, it, expect, vi } from 'vitest'

import { createApplication } from './application_builder.js'
import type { SignalDispatcher, ShutdownSignal } from './shutdown/signals.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Records signal wiring without touching the real process. */
class FakeDispatcher implements SignalDispatcher {
  readonly pid = 4321
  readonly handlers = new Map<ShutdownSignal, () => void>()
  exitCode: number | undefined

  on(signal: ShutdownSignal, handler: () => void): void {
    this.handlers.set(signal, handler)
  }

  off(signal: ShutdownSignal): void {
    this.handlers.delete(signal)
  }

  exit(): void {}
  setExitCode(code: number): void {
    this.exitCode = code
  }

  warn(): void {}
  error(): void {}
}

// A headless application had no signal handling and no drain at all before graceful shutdown moved into
// BaseApplication — a Kafka consumer with no HTTP server was simply killed mid-message.
describe('headless application shutdown', () => {
  it('refuses traffic before the drain delay and disposes the container after it', async () => {
    let hookAt = 0

    class Recorder implements OnDestroy {
      onDestroy() {
        hookAt = Date.now()
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Recorder, t => t.toSelf())

    const app = createApplication({ container })
      .shutdown(s => s.drainDelay(300))
      .build()

    await app.run()

    expect(app.availability.ready).toBe('accepting')
    expect(app.availability.started).toBe(true)

    const startedAt = Date.now()
    const closing = app.close()

    // No await in between: the flip has to be immediate, not deferred until the delay elapses.
    expect(app.availability.draining).toBe(true)
    expect(app.availability.ready).toBe('refusing')
    expect(app.availability.live).toBe('correct')

    await closing

    expect(hookAt - startedAt).toBeGreaterThanOrEqual(250)
    expect(app.availability.live).toBe('broken')
  })

  it('skips the wait when no drain delay is configured', async () => {
    const app = createApplication().build()
    await app.run()

    const startedAt = Date.now()
    await app.close()

    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  it('joins a second close instead of starting another one', async () => {
    let hooks = 0

    class Recorder implements OnDestroy {
      onDestroy() {
        hooks++
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Recorder, t => t.toSelf())

    const app = createApplication({ container })
      .shutdown(s => s.drainDelay(100))
      .build()
    await app.run()

    await Promise.all([app.close(), app.close()])

    expect(hooks).toBe(1)
  })

  it('installs the configured signals and drains when one arrives', async () => {
    const dispatcher = new FakeDispatcher()
    const app = createApplication()
      .shutdown(s => s.drainDelay(50).signals(['SIGTERM']).dispatcher(dispatcher))
      .build()

    await app.run()

    expect(dispatcher.handlers.has('SIGTERM')).toBe(true)

    dispatcher.handlers.get('SIGTERM')!()
    await vi.waitFor(() => expect(dispatcher.exitCode).toBe(0))

    expect(app.availability.draining).toBe(true)
    // Handlers are removed only once the shutdown has finished, so a second signal can still force an exit.
    expect(dispatcher.handlers.size).toBe(0)
  })

  it('installs nothing under a test runner by default', async () => {
    const before = process.listenerCount('SIGTERM')
    const app = createApplication().build()

    await app.run()

    expect(process.listenerCount('SIGTERM')).toBe(before)

    await app.close()
  })

  it('still disposes the container when a destroy hook throws', async () => {
    class Failing implements OnDestroy {
      onDestroy() {
        throw new Error('hook failed')
      }
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Failing, t => t.toSelf())

    const app = createApplication({ container }).build()
    await app.run()

    await expect(app.close()).rejects.toThrow(AggregateError)
    await sleep(0)

    expect(app.availability.live).toBe('broken')
  })
})
