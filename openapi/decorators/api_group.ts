import { configureRouter } from '@caffeinejs/http/decorators/registrar'
import type { APIGroupDetail } from './detail.js'
import { kAPIGroup } from './keys.js'

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
  const resolved: APIGroupDetail = typeof detail === 'string' ? { name: detail } : detail

  return function (target: Function, context: ClassDecoratorContext): void {
    configureRouter(context, target, spec => spec.extras(kAPIGroup, resolved))
  }
}
