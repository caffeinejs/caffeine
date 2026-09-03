import { BuiltInResolvers, type InjectionResolverFactory } from './injection_resolver.js'
import {
  configFactory,
  deferredFactory,
  standardFactory,
  objectFactory,
  mappedFactory,
  orderedFactory,
  providerFactory,
  valueFactory,
} from './internal/core/resolver/index.js'

/**
 * The resolvers every container starts with, paired with the names they answer to.
 *
 * A table rather than a set of registrations, so the module has no side effect and the wiring is a real dependency
 * of whoever performs it — `container.ts`. Nothing under `internal/core/resolver/` may import this module: that
 * import is the cycle the registry module exists to avoid.
 */
export const builtInResolvers: ReadonlyArray<readonly [symbol, InjectionResolverFactory]> = [
  [BuiltInResolvers.CONFIG, configFactory],
  [BuiltInResolvers.DEFAULT, standardFactory],
  [BuiltInResolvers.MAP, mappedFactory],
  [BuiltInResolvers.DEFER, deferredFactory],
  [BuiltInResolvers.OBJECT, objectFactory],
  [BuiltInResolvers.ORDERED, orderedFactory],
  [BuiltInResolvers.PROVIDER, providerFactory],
  [BuiltInResolvers.VALUE, valueFactory],
]
