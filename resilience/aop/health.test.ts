import { createApplication, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrInvalidOption } from '../errors.js'
import { Resilience, type ResilienceBuilder } from './feature.js'
import { ResilienceRegistry } from './registry.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close()
  }
})

const presets = (r: ResilienceBuilder) =>
  r
    .preset('payments', p =>
      p
        .retry({ maxAttempts: 2 })
        .circuitBreaker({ automaticTransitionFromOpenToHalfOpen: true, waitDurationInOpenState: 30 * Second }),
    )
    .preset('recommendations', p => p.circuitBreaker())
    .preset('ledger', p => p.retry())

// Boots an application that takes traffic, so readiness answers from its indicators alone.
async function boot(feature: Feature) {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(feature)
  opened.push(() => app.close())
  await app.bootstrap()
  app.availability.markStarted().acceptTraffic()
  return { app, registry: app.container.get(ResilienceRegistry) }
}

async function readiness(app: Awaited<ReturnType<typeof boot>>['app']) {
  const result = await app.health.readiness()
  return { ok: result.ok, outcome: result.outcomes.find(outcome => outcome.name === 'resilience') }
}

function bootError(feature: Feature): Promise<unknown> {
  return boot(feature).catch((reason: unknown) => reason)
}

// An open breaker on a dependency the service can live without must not take every replica out of the load balancer.
describe('Resilience(r => r.health(...))', () => {
  it('reports up while every breaker is closed', async () => {
    const { app } = await boot(Resilience(r => presets(r).health({ critical: ['payments'] })))

    expect(await readiness(app)).toEqual({
      ok: true,
      outcome: expect.objectContaining({ status: 'up', critical: true }),
    })
  })

  it('reports a breaker outside critical as degraded, and keeps readiness passing', async () => {
    const { app, registry } = await boot(Resilience(r => presets(r).health({ critical: ['payments'] })))
    registry.circuitBreaker('recommendations').transitionToOpen()

    expect(await readiness(app)).toEqual({
      ok: true,
      outcome: expect.objectContaining({
        status: 'degraded',
        detail: 'recommendations is open',
        data: { open: { recommendations: 'open' } },
      }),
    })
  })

  it('fails readiness while a critical breaker is open', async () => {
    const { app, registry } = await boot(Resilience(r => presets(r).health({ critical: ['payments'] })))
    registry.circuitBreaker('payments').transitionToOpen()
    registry.circuitBreaker('recommendations').forceOpen()

    expect(await readiness(app)).toEqual({
      ok: false,
      outcome: expect.objectContaining({
        status: 'down',
        detail: 'payments is open, recommendations is forced_open',
        data: { open: { payments: 'open', recommendations: 'forced_open' } },
      }),
    })
  })

  // Half open lets trial calls through to close the breaker: failing readiness would keep them away.
  it('keeps readiness passing while a critical breaker is half open', async () => {
    const { app, registry } = await boot(Resilience(r => presets(r).health({ critical: ['payments'] })))
    registry.circuitBreaker('payments').transitionToHalfOpen()

    expect(await readiness(app)).toEqual({
      ok: true,
      outcome: expect.objectContaining({ status: 'degraded', data: { open: { payments: 'half_open' } } }),
    })
  })

  it('reports every breaker as degraded when nothing is critical', async () => {
    const { app, registry } = await boot(Resilience(r => presets(r).health()))
    registry.circuitBreaker('payments').transitionToOpen()

    expect(await readiness(app)).toEqual({
      ok: true,
      outcome: expect.objectContaining({ status: 'degraded', data: { open: { payments: 'open' } } }),
    })
  })

  it('binds no indicator without health()', async () => {
    const { app, registry } = await boot(Resilience(presets))
    registry.circuitBreaker('payments').transitionToOpen()

    expect(await readiness(app)).toEqual({ ok: true, outcome: undefined })
  })

  // A typo in critical would otherwise leave the breaker it meant unwatched, with nothing to say so.
  it.each([
    [
      'a preset nothing defines',
      ['payment'],
      'Cannot report the health of preset "payment": no preset by that name is defined',
    ],
    [
      'a preset with no breaker',
      ['ledger'],
      'Cannot report the health of preset "ledger": the preset defines no circuit breaker',
    ],
  ])('refuses to start when critical names %s', async (_, critical, message) => {
    const error = await bootError(Resilience(r => presets(r).health({ critical })))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(message)
  })

  // Without the automatic move, an open breaker waits for a call that a failing readiness probe keeps away: the
  // replica would stay out of the load balancer until it restarts.
  it('refuses a critical breaker that leaves the open state only on a call', async () => {
    const error = await bootError(Resilience(r => presets(r).health({ critical: ['recommendations'] })))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toBe(
      [
        'Cannot report the health of preset "recommendations": its circuit breaker leaves the open state only on a call, which a failing readiness probe keeps away',
        'Possible Solutions:',
        "  - Set automaticTransitionFromOpenToHalfOpen: true in r.preset('recommendations', p => p.circuitBreaker({ ... }))",
        '  - Leave "recommendations" out of critical, so its open breaker reports degraded',
      ].join('\n'),
    )
  })

  it('refuses critical when it is not an array of names', async () => {
    const error = await bootError(Resilience(r => presets(r).health({ critical: 'payments' as never })))

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot report the resilience health: critical must be an array of preset names, got a string',
    )
  })

  it('refuses health() twice', async () => {
    const error = await bootError(
      Resilience(r =>
        presets(r)
          .health()
          .health({ critical: ['payments'] }),
      ),
    )

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe('Cannot report the resilience health twice')
  })
})
