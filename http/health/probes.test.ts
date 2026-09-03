import {
  ApplicationAvailability,
  HealthIndicator,
  type HealthGroup,
  type HealthReport,
  down,
  up,
} from '@caffeinejs/std'
import { describe, it, expect } from 'vitest'

import { type HealthOptions, defaultHealthOptions } from './options.js'
import { ProbeEndpoint } from './probes.js'
import { HealthRegistry } from './registry.js'

class Stub extends HealthIndicator {
  constructor(
    private readonly id: string,
    private readonly report: () => HealthReport,
    private readonly groupList?: readonly HealthGroup[],
    private readonly isCritical?: boolean,
  ) {
    super()
  }

  get name(): string {
    return this.id
  }

  get groups(): readonly HealthGroup[] {
    return this.groupList ?? super.groups
  }

  get critical(): boolean {
    return this.isCritical ?? super.critical
  }

  check(): HealthReport {
    return this.report()
  }
}

function endpoint(
  indicators: HealthIndicator[] = [],
  overrides: Partial<HealthOptions> = {},
): {
  probes: ProbeEndpoint
  availability: ApplicationAvailability
} {
  const options = { ...defaultHealthOptions({}), ...overrides }
  const availability = new ApplicationAvailability()
  const registry = new HealthRegistry(indicators, options)

  return { probes: new ProbeEndpoint(availability, registry, options), availability }
}

function running(
  indicators: HealthIndicator[] = [],
  overrides: Partial<HealthOptions> = {},
): {
  probes: ProbeEndpoint
  availability: ApplicationAvailability
} {
  const made = endpoint(indicators, overrides)
  made.availability.markStarted().acceptTraffic()
  return made
}

describe('ProbeEndpoint', () => {
  describe('livez', () => {
    it('passes while a readiness indicator is failing', async () => {
      const { probes } = running([new Stub('db', () => down('connection refused'))])

      expect((await probes.live()).status).toBe(200)
      expect((await probes.ready()).status).toBe(503)
    })

    it('passes while draining', async () => {
      const { probes, availability } = running()

      availability.beginDrain()

      expect((await probes.live()).status).toBe(200)
    })

    it('passes before boot completes', async () => {
      const { probes } = endpoint()

      expect((await probes.live()).status).toBe(200)
    })

    it('fails only when the process is explicitly marked broken', async () => {
      const { probes, availability } = running()

      availability.markBroken('deadlocked')

      expect((await probes.live()).status).toBe(503)
    })

    it('honours an indicator a user placed in the liveness group', async () => {
      const { probes } = running([new Stub('deadlock', () => down('stuck'), ['liveness'])])

      expect((await probes.live()).status).toBe(503)
    })
  })

  describe('readyz', () => {
    it('fails before boot completes', async () => {
      const { probes } = endpoint()

      expect((await probes.ready()).status).toBe(503)
    })

    it('passes once running', async () => {
      const { probes } = running()

      const response = await probes.ready()

      expect(response.status).toBe(200)
      expect(response.body).toBe('ok')
      expect(response.headers['cache-control']).toBe('no-store')
    })

    it('fails as soon as draining starts', async () => {
      const { probes, availability } = running()

      availability.beginDrain()

      const response = await probes.ready()

      expect(response.status).toBe(503)
      expect(response.body).toBe('readyz check failed')
    })

    it('does not touch indicators while draining', async () => {
      let checked = false
      const indicator = new Stub('db', () => {
        checked = true
        return up()
      })
      const { probes, availability } = running([indicator])

      availability.beginDrain()
      await probes.ready()

      expect(checked).toBe(false)
    })

    it('stays up when a non-critical indicator is down', async () => {
      const { probes } = running([new Stub('metrics', () => down('unreachable'), undefined, false)])

      expect((await probes.ready()).status).toBe(200)
    })
  })

  describe('startupz', () => {
    it('fails before boot and passes after', async () => {
      const { probes, availability } = endpoint()

      expect((await probes.startup()).status).toBe(503)

      availability.markStarted()

      expect((await probes.startup()).status).toBe(200)
    })

    it('keeps passing while draining, so a shutting-down pod is not treated as never-started', async () => {
      const { probes, availability } = running()

      availability.beginDrain()

      expect((await probes.startup()).status).toBe(200)
    })
  })

  describe('verbose', () => {
    it('ignores the query parameter when the feature is disabled', async () => {
      const { probes } = running([new Stub('db', up)])

      expect((await probes.ready({ verbose: true })).body).toBe('ok')
    })

    it('renders kubernetes-style lines when enabled', async () => {
      const { probes } = running([new Stub('db', up)], { verbose: true })

      const response = await probes.ready({ verbose: true })

      expect(response.body).toBe(
        ['[+]started ok', '[+]accepting ok', '[+]live ok', '[+]db ok', 'readyz check passed', ''].join('\n'),
      )
    })

    it('names the failing indicator and its reason', async () => {
      const { probes } = running(
        [
          new Stub('db', () => down('connection refused')),
          new Stub('metrics', () => down('unreachable'), undefined, false),
        ],
        { verbose: true },
      )

      const response = await probes.ready({ verbose: true })

      expect(response.status).toBe(503)
      expect(response.body).toContain('[-]db failed: connection refused')
      expect(response.body).toContain('[-]metrics degraded: unreachable')
      expect(response.body).toContain('readyz check failed')
    })

    it('reports the drain reason', async () => {
      const { probes, availability } = running([], { verbose: true })

      availability.beginDrain()

      expect((await probes.ready({ verbose: true })).body).toContain('[-]accepting failed: shutdown')
    })
  })

  describe('exclude', () => {
    it('ignores the query parameter when the feature is disabled', async () => {
      const { probes } = running([new Stub('db', () => down('connection refused'))])

      expect((await probes.ready({ exclude: ['db'] })).status).toBe(503)
    })

    it('skips the named indicator when enabled', async () => {
      const { probes } = running([new Stub('db', () => down('connection refused'))], { exclude: true })

      expect((await probes.ready({ exclude: ['db'] })).status).toBe(200)
      expect((await probes.ready()).status).toBe(503)
    })
  })
})
