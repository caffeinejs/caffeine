import { type Duration, formatDuration, Second } from '@caffeinejs/std/duration'

/**
 * Why a lifetime written to the wire in whole seconds cannot work, or `undefined` when it can. Under one second it
 * would be written as `0`, which a browser takes as "delete" and a sealed token as "already expired".
 */
export function lifetimeViolation(option: string, lifetime: Duration | undefined): string | undefined {
  if (lifetime === undefined || (Number.isFinite(lifetime) && lifetime >= Second)) {
    return undefined
  }

  return `${option} must be a finite Duration of at least 1s, got "${formatDuration(lifetime)}"`
}
