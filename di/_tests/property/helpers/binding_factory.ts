import { newBinding } from '../../../binding.js'
import { token } from '../../../key.js'
import type { Binding } from '../../../binding.js'

const SINGLETON = token<any>(Symbol('singleton'))

export { SINGLETON }

export function binding(
  id: number,
  opts: {
    scopeID?: symbol
    names?: (string | symbol)[]
    labels?: symbol[]
    primary?: boolean
    lazy?: boolean
    injections?: { key?: unknown }[]
    injectableProperties?: Map<string | symbol, { key?: unknown }>
    injectableMethods?: Map<string | symbol, { key?: unknown }[]>
  } = {},
): Binding {
  return newBinding({
    id,
    scopeID: opts.scopeID ?? SINGLETON,
    factory: undefined as any,
    names: opts.names ?? [],
    labels: opts.labels ?? [],
    primary: opts.primary,
    lazy: opts.lazy,
    injections: (opts.injections ?? []) as any,
    injectableProperties: (opts.injectableProperties ?? new Map()) as any,
    injectableMethods: (opts.injectableMethods ?? new Map()) as any,
  })
}
