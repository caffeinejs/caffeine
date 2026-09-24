import type { Call } from './call.js'

/** Why an optional call did not produce a value. The downstream error stays off the arm. */
export type FailureReason = 'timeout' | 'unavailable'

/**
 * An optional call's outcome. A required call does not use this: its value is stored bare, and its failure
 * rejects `join`.
 */
export type Arm<T> = { ok: true; value: T } | { ok: false; reason: FailureReason }

export interface RequiredCall<T> {
  readonly kind: 'required'
  readonly call: Call<T>
}

export interface OptionalCall<T> {
  readonly kind: 'optional'
  readonly call: Call<T>
}

export type CallSpec<T> = RequiredCall<T> | OptionalCall<T>

/** A failure rejects `join`. The value is stored bare. */
export function required<T>(call: Call<T>): RequiredCall<T> {
  return { kind: 'required', call }
}

/** A failure becomes an {@link Arm} with a reason. The screen still resolves. */
export function optional<T>(call: Call<T>): OptionalCall<T> {
  return { kind: 'optional', call }
}
