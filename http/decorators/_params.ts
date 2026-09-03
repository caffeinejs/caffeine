import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import { $p, type HTTPPickers } from '../route_picker.js'

export type Picks = ParameterPickOptions<unknown>[]

export function resolveParams(arg: Picks | ((p: HTTPPickers) => Picks)): Picks {
  return typeof arg === 'function' ? arg($p) : arg
}
