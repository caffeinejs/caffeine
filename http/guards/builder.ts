import { Scopes, type InjectionToken } from '@caffeinejs/di'
import { type Service, type ServiceAPI, type ServiceBootstrapIn } from '@caffeinejs/std'
import type { Guard } from './guard.js'
import { kGlobalGuards } from './keys.js'

/**
 * Records the Keys of guards that run on every route. Does not bind the classes — they must already
 * be in the container (`@Injectable()` or `container.bind(X)`).
 *
 * Order of {@link GuardsBuilder.global} is global execution order, before controller- and method-level `@UseGuards`.
 */
export class GuardsBuilder implements Service {
  readonly #keys: InjectionToken<Guard>[] = []

  get name(): string {
    return 'guards'
  }

  global(key: InjectionToken<Guard>, ...keys: InjectionToken<Guard>[]): ServiceAPI<this> {
    this.#keys.push(key, ...keys)
    return this
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    kit.container
      .bind(kGlobalGuards)
      .toValue(this.#keys)
      .lifetime(Scopes.SINGLETON)
      .internal()

    return Promise.resolve()
  }
}
