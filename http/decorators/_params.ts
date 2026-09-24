import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import { $p, type HTTPPickers } from '../routing/picker.js'

/**
 * The picks a route declares.
 *
 * `never` rather than `unknown` because `ParameterPickOptions` holds `R` in a parameter position and is
 * therefore contravariant in it: `never` is the end that accepts, so a pick whose function annotated its
 * request — `p.pick((req: { httpContext: Context }) => …)` — is assignable here alongside every built-in.
 * With `unknown` the annotated one fails overload resolution with `TS2769`.
 */
export type Picks = ParameterPickOptions<never>[]

export function resolveParams(arg: Picks | ((p: HTTPPickers) => Picks)): Picks {
  return typeof arg === 'function' ? arg($p) : arg
}
