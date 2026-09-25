import { createApplication } from '@caffeinejs/std'
import { HealthIndicator, down, type HealthReport } from '@caffeinejs/std/health'
import { newNoopLogger } from '@caffeinejs/std/logger'
import { getGlobal, updateGlobals } from '@platformatic/globals'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerWattChecks } from './watt.js'

// What Watt installs in each worker, reduced to the two setters the example calls. Each keeps the check it is
// handed, so a spec can poll it the way Watt's probe server does.
function underWatt(): { readiness: () => Promise<unknown>; liveness: () => Promise<unknown> } {
  const checks = new Map<string, () => unknown>()

  updateGlobals({
    setCustomReadinessCheck: check => void checks.set('readiness', check),
    setCustomHealthCheck: check => void checks.set('liveness', check),
  })

  return {
    readiness: async () => checks.get('readiness')?.(),
    liveness: async () => checks.get('liveness')?.(),
  }
}

const refused = (probe: string) => ({ status: false, statusCode: 503, body: `${probe} check failed` })

afterEach(() => {
  delete (globalThis as { platformatic?: unknown }).platformatic
})

describe('registerWattChecks', () => {
  // The same entry module runs under plain Node, where there is no Watt to answer.
  it('does nothing outside Watt', async () => {
    const app = createApplication()
    await app.ready()

    expect(() => registerWattChecks(app)).not.toThrow()
    expect(getGlobal()).toBeUndefined()

    await app.close()
  })

  // Watt must not route to an application before it serves, nor keep routing to one that is shutting down.
  it('answers readiness from the lifecycle: refused before run(), ready while serving, refused once closing', async () => {
    const watt = underWatt()
    const app = createApplication()
    await app.ready()
    registerWattChecks(app)

    expect(await watt.readiness()).toEqual(refused('readyz'))
    expect(await watt.liveness()).toEqual({ status: true })

    await app.run()

    expect(await watt.readiness()).toEqual({ status: true })

    const closing = app.close()

    expect(await watt.readiness()).toEqual(refused('readyz'))
    await closing
  })

  // Watt's probe server answers whoever asks, so the body says which probe failed and never which dependency.
  it('fails readiness for a critical dependency without naming it', async () => {
    class Postgres extends HealthIndicator {
      get name(): string {
        return 'postgres'
      }

      check(): HealthReport {
        return down('connection refused')
      }
    }

    const watt = underWatt()
    const app = createApplication()
    app.container.bind(Postgres, t => t.toSelf().extends(HealthIndicator))
    await app.ready()
    registerWattChecks(app)
    await app.run()

    const verdict = await watt.readiness()

    expect(verdict).toEqual(refused('readyz'))
    expect(JSON.stringify(verdict)).not.toContain('postgres')
    await app.close()
  })

  // A runtime older than 3.56 installs its global without the fields the typed setters look up. Registering nothing
  // is all that is left, and doing it silently would leave the application with no readiness gate at all.
  it('warns, rather than registering, under a Watt too old for the typed setters', async () => {
    const setCustomReadinessCheck = vi.fn()
    ;(globalThis as { platformatic?: unknown }).platformatic = {
      setCustomReadinessCheck,
      setCustomHealthCheck: vi.fn(),
    }
    const warn = vi.fn()
    const app = createApplication({ logger: { ...newNoopLogger(), warn } })
    await app.ready()

    registerWattChecks(app)

    expect(setCustomReadinessCheck).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Watt 3.56 or later'))
    await app.close()
  })
})
