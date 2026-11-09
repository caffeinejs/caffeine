import { degraded, HealthIndicator, type HealthReport, up } from '@caffeinejs/application/health'
import { Second } from '@caffeinejs/std/duration'

import type { DistLock } from './distlock.js'

// The key every replica's probe takes. Shared on purpose: a probe that finds another replica's holding it has still
// heard the backend answer.
const PROBE_KEY = 'caffeine:distlock:health'

/**
 * Reports whether the lock backend answers, to the readiness probe, by taking and releasing one short lease.
 *
 * Never critical: the lock store is shared by every replica, so a failing probe never fails readiness and leaves each
 * one in the Service. Failing readiness would take the whole fleet out at once, with no pod left to show it recovered.
 * A key found held by another replica's probe counts as up, since the backend answered.
 */
export class DistLockHealth extends HealthIndicator {
  readonly #lock: DistLock

  constructor(lock: DistLock) {
    super()
    this.#lock = lock
  }

  get name(): string {
    return 'distlock'
  }

  override get critical(): boolean {
    return false
  }

  async check(signal: AbortSignal): Promise<HealthReport> {
    try {
      const held = await this.#lock.tryAcquire(PROBE_KEY, { ttl: 1 * Second, signal })
      await held?.release()
      return up()
    } catch (error) {
      return degraded(firstLine(error))
    }
  }
}

// A message's first line says what failed; the solutions after it are for whoever reads the log.
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n', 1)[0]!
}
