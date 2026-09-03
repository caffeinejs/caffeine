import { BuiltInStages, type InjectionMiddleware } from './injection_resolver.js'
import {
  configStage,
  manyStage,
  mapStage,
  objectStage,
  providerStage,
  sortStage,
  valueStage,
} from './internal/core/resolver/index.js'

/**
 * The injection stages every container starts with, paired with the names they answer to and whether each one
 * decides what the injection resolves to.
 *
 * A table rather than a set of registrations, so the module has no side effect and the wiring is a real dependency
 * of whoever performs it — `container.ts`. Nothing under `internal/core/resolver/` may import this module: that
 * import is the cycle the registry module exists to avoid.
 */
export const builtInStages: ReadonlyArray<readonly [symbol, InjectionMiddleware, { terminal?: boolean }]> = [
  [BuiltInStages.CONFIG, configStage, { terminal: true }],
  [BuiltInStages.MANY, manyStage, { terminal: true }],
  [BuiltInStages.MAP, mapStage, { terminal: true }],
  [BuiltInStages.OBJECT, objectStage, { terminal: true }],
  [BuiltInStages.PROVIDER, providerStage, {}],
  [BuiltInStages.SORT, sortStage, {}],
  [BuiltInStages.VALUE, valueStage, { terminal: true }],
]
