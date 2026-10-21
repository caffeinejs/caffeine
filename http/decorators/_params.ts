import { $p, type HTTPPickers, type Picks } from '../core/routing/picker.js'

export function resolveParams(arg: Picks | ((p: HTTPPickers) => Picks)): Picks {
  return typeof arg === 'function' ? arg($p) : arg
}
