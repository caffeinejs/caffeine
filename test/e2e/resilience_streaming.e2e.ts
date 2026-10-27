import { once } from 'node:events'

import { CaffeineIoC, Profile } from '@caffeinejs/di'
import { Controller, Get } from '@caffeinejs/http'
import { Resilience, ResilienceRegistry, TimeLimiter } from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler } from '@caffeinejs/resilience/http'
import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'

/**
 * A handler that returns a body to stream, over a real socket. Its `@TimeLimiter` bounds the handler, not the download:
 * a client still reading the body after the limit gets all of it.
 */

const encoder = new TextEncoder()
let release: () => void = () => undefined
const signals: AbortSignal[] = []

@Controller('/reports')
@Profile('e2e-resilience-streaming')
class ReportsController {
  @Get('/ping')
  async ping(): Promise<string> {
    return 'pong'
  }

  // Returns at once with the first chunk; the rest waits for the test, and is cut if the handler's signal aborts.
  @TimeLimiter('export')
  @Get('/export', p => [p.signal()])
  async export(signal: AbortSignal): Promise<Response> {
    signals.push(signal)
    const rest = new Promise<void>(resolve => (release = resolve))
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('head'))
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
        async pull(controller) {
          await rest
          if (!signal.aborted) {
            controller.enqueue(encoder.encode('tail'))
            controller.close()
          }
        },
      }),
    )
  }
}
void ReportsController

let running: RunningApp
let registry: ResilienceRegistry

beforeAll(async () => {
  const container = new CaffeineIoC({ profiles: ['e2e-resilience-streaming'] })
  running = await startApp(
    app =>
      app
        .install(Resilience(r => r.timeLimiter('export', { timeoutDuration: 100 * Millisecond })))
        .errorHandling(e => e.globalHandlers(ResilienceErrorHandler)),
    { container },
  )
  registry = container.get(ResilienceRegistry)
  // undici builds its clock on the first fetch of the file: one built on a faked setTimeout never ticks again.
  expect(await (await fetch(`${running.origin}/reports/ping`)).text()).toBe('pong')
})

afterAll(async () => {
  vi.useRealTimers()
  release()
  await running.close()
})

describe('a streamed response under a handler time limit', { timeout: 30_000 }, () => {
  it('reaches a client still reading after the limit, whole, and counts no timeout', async () => {
    // Faked before the request, so the limit's own timer is on the driven clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const res = await fetch(`${running.origin}/reports/export`)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe('head')

    await vi.advanceTimersByTimeAsync(1 * Second)

    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    expect(registry.timeLimiter('export').metrics()).toEqual({ successfulCalls: 1, failedCalls: 0, timedOutCalls: 0 })

    release()
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value, { stream: true })
    }
    expect(rest).toBe('tail')
  })

  // The limit stops timing the body once the handler returns, but the client leaving must still stop the work the body
  // does: the handler's signal is all it has to learn of it.
  it('aborts the signal the body holds when the client leaves mid-download', async () => {
    const client = new AbortController()
    const res = await fetch(`${running.origin}/reports/export`, { signal: client.signal })
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('head')
    const signal = signals.at(-1)!
    const aborted = once(signal, 'abort')

    client.abort()

    await aborted
    expect(signal.aborted).toBe(true)
    expect(registry.timeLimiter('export').metrics().timedOutCalls).toBe(0)
  })
})
