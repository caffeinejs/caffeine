import { Lifetime, Scopes, type Binding, type Container } from '@caffeinejs/di'
import { HealthIndicator } from '@caffeinejs/std'

import { solutions } from '../error/util.js'
import { ErrHealthIndicatorNotSingleton } from './errors.js'

/**
 * The indicators bound under {@link HealthIndicator}, after confirming each is a singleton.
 *
 * Called after `container.init()`: {@link Container.getManyOptional} is not legal before that, and the
 * registry that consumes the result holds the instances for the process. A non-singleton binding would be
 * snapshotted once and never recreated.
 */
export function loadHealthIndicators(container: Container): HealthIndicator[] {
  for (const binding of container.getBindings(HealthIndicator)) {
    if (binding.scopeID !== Scopes.SINGLETON) {
      const name = nameOf(binding)
      throw new ErrHealthIndicatorNotSingleton(
        `Cannot load health indicator "${name}": lifetime must be singleton` +
          solutions(
            `Remove @${Lifetime.name}(...) or .lifetime(...) so the default singleton applies, or set it to Scopes.SINGLETON`,
            'Inject a narrower-scoped dependency as Provider<T> with $i.provide(Dep) instead of changing the indicator lifetime',
          ),
      )
    }
  }

  return container.getManyOptional(HealthIndicator)
}

function nameOf(binding: Binding): string {
  const type = binding.type
  if (typeof type === 'function' && type.name.length > 0) {
    return type.name
  }

  const key = binding.ctx?.key
  if (typeof key === 'function' && key.name.length > 0) {
    return key.name
  }
  if (typeof key === 'string') {
    return key
  }
  if (typeof key === 'symbol') {
    return key.description ?? key.toString()
  }

  return '<anonymous>'
}
