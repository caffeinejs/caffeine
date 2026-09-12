import { Scopes, type InjectionToken } from '@caffeinejs/di'
import {
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type Feature,
  type FeatureConfigureKit,
} from '@caffeinejs/std'

import type { Guard } from './guard.js'
import { kGlobalGuards } from './keys.js'

/**
 * Records the Keys of guards that run on every route. Does not bind the classes — they must already
 * be in the container (`@Injectable()` or `container.bind(X)`).
 *
 * Order of {@link GuardsBuilder.global} is global execution order, before controller- and method-level `@UseGuards`.
 */
export class GuardsBuilder implements Feature {
  readonly [kFeatureName] = 'guards'

  readonly #keys: InjectionToken<Guard>[] = []

  global(key: InjectionToken<Guard>, ...keys: InjectionToken<Guard>[]): this {
    this.#keys.push(key, ...keys)
    return this
  }

  [kFeatureConfigure](kit: FeatureConfigureKit): void {
    kit.container.bind(kGlobalGuards, t => t.toValue(this.#keys).lifetime(Scopes.SINGLETON).internal())
  }

  [kFeatureBootstrap](): void {
    // Nothing to register.
  }
}
