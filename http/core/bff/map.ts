import type { Call } from './call.js'

/** Transforms the value a call produced. A throw rejects the call. */
export function map<T, U>(fn: (value: T) => U): (call: Call<T>) => Call<U> {
  return call => async signal => fn(await call(signal))
}
