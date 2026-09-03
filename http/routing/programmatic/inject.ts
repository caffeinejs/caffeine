import { $i, type Container, type ObjectInjectionSpec } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import { $p } from '../../route_picker.js'

/**
 * Compiles the dependencies a route declared into the picker that hands them to its handler.
 *
 * The whole spec becomes one `$i.object` descriptor, so resolution is the container's — the same code an
 * `@Injectable` constructor goes through, with the same support for `$i.optional`, `$i.allOf` and the rest.
 *
 * The bag it produces is built once, here, and reused for every request: its fields are getters that resolve
 * through the binding on each access, so a singleton hands back the one instance, a transient a new one, and a
 * request-scoped binding the instance belonging to the scope the request is running in. Nothing about resolution
 * has to happen per request for that to hold, which is why nothing does.
 */
export function compileInjection(
  container: Container,
  spec: ObjectInjectionSpec | undefined,
): ParameterPickOptions<unknown> | undefined {
  if (spec === undefined || isEmpty(spec)) {
    return undefined
  }

  return $p.just(container.resolver($i.object(spec))())
}

function isEmpty(spec: ObjectInjectionSpec): boolean {
  return Object.keys(spec).length === 0 && Object.getOwnPropertySymbols(spec).length === 0
}
