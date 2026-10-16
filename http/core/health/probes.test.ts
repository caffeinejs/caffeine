import {
  ApplicationAvailability,
  ApplicationHealth,
  HealthIndicator,
  HealthRegistry,
  type HealthGroup,
  type HealthReport,
  defaultHealthRegistryOptions,
  down,
  up,
} from '@caffeinejs/std/health'
import { describe, it, expect } from 'vitest'

import { renderProbe } from './probes.js'

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

  override get groups(): readonly HealthGroup[] {
    return this.groupList ?? super.groups
  }

  override get critical(): boolean {
    return this.isCritical ?? super.critical
  }

  check(): HealthReport {
    return this.report()
  }
}

function running(indicators: HealthIndicator[] = []): {
  health: ApplicationHealth
  availability: ApplicationAvailability
} {
  const availability = new ApplicationAvailability().markStarted().acceptTraffic()
  const registry = new HealthRegistry(indicators, defaultHealthRegistryOptions())

  return { health: new ApplicationHealth(availability, registry), availability }
}

describe('renderProbe', () => {
  it('answers ok, uncacheable, when the probe passes', async () => {
    const { health } = running([new Stub('db', up)])

    const response = renderProbe('readyz', await health.readiness(), false)

    expect(response.status).toBe(200)
    expect(response.body).toBe('ok')
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('names only the probe when it fails and verbose is off, so the body leaks no dependency', async () => {
    const { health } = running([new Stub('db', () => down('connection refused'))])

    const response = renderProbe('readyz', await health.readiness(), false)

    expect(response.status).toBe(503)
    expect(response.body).toBe('readyz check failed')
  })

  describe('verbose', () => {
    it('renders kubernetes-style lines', async () => {
      const { health } = running([new Stub('db', up)])

      const response = renderProbe('readyz', await health.readiness(), true)

      expect(response.body).toBe(
        ['[+]started ok', '[+]accepting ok', '[+]live ok', '[+]db ok', 'readyz check passed', ''].join('\n'),
      )
    })

    it('names the failing indicator and its reason', async () => {
      const { health } = running([
        new Stub('db', () => down('connection refused')),
        new Stub('metrics', () => down('unreachable'), undefined, false),
      ])

      const response = renderProbe('readyz', await health.readiness(), true)

      expect(response.status).toBe(503)
      expect(response.body).toContain('[-]db failed: connection refused')
      expect(response.body).toContain('[-]metrics degraded: unreachable')
      expect(response.body).toContain('readyz check failed')
    })

    it('reports the drain reason', async () => {
      const { health, availability } = running()

      availability.beginDrain()

      expect(renderProbe('readyz', await health.readiness(), true).body).toContain('[-]accepting failed: shutdown')
    })
  })
})
