import type { RouteGroupExtension } from '@caffeinejs/http'
import { configureRouteGroup } from '@caffeinejs/http/decorators/registrar'

import type { APIGroupDetail } from './detail.js'
import { kAPIGroup } from './keys.js'

/**
 * Tags a `Router`'s routes and carries what applies to all of them. The programmatic form of {@link APIGroup}, and
 * what it is implemented with.
 *
 * ```ts
 * const pets = new Router('/pets').with(apiGroup({ name: 'Pets', description: 'Browse and manage pets' }))
 * ```
 */
export function apiGroup(detail: APIGroupDetail | string): RouteGroupExtension {
  const resolved: APIGroupDetail = typeof detail === 'string' ? { name: detail } : detail

  return group => group.extras(kAPIGroup, resolved)
}

/**
 * Groups a controller's routes under one OpenAPI tag, and carries whatever should apply to all of them.
 *
 * The tag's description is written once here rather than repeated on every operation: the generator emits a
 * top-level `tags[]` entry from it, which is what a consumer renders as a section heading.
 *
 * ```ts
 * @APIGroup({ name: 'Pets', description: 'Browse and manage pets' })
 * @Controller('/pets', [PetsRepository])
 * export class PetsController { ... }
 * ```
 *
 * The name alone is the common case, so `@APIGroup('Pets')` is accepted as shorthand. Without the decorator
 * the tag is derived from the class name, so a controller only needs it to say something the name does not.
 */
export function APIGroup(detail: APIGroupDetail | string) {
  return function (target: Function, context: ClassDecoratorContext): void {
    configureRouteGroup(context, target, apiGroup(detail))
  }
}
