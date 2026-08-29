import { ErrInvalidDecorator, type Key } from '@caffeinejs/di'
import type { Guard } from '../guards/guard.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouter } from './registrar/registrar.js'

/**
 * Attaches one or more container-managed {@link Guard} classes to a controller or a single route.
 *
 * Guards are referenced by class or by a name given with `@Named`, and are resolved through the
 * container. Execution order is global (`.guards(g => g.use(...))`), then controller, then method.
 * All must allow the request; the first denial wins.
 *
 * @param guards - Guard classes, or `@Named` identifiers of Guard classes. At least one is required.
 */
export function UseGuards(...guards: Key<Guard>[]) {
  if (guards.length === 0) {
    throw new ErrInvalidDecorator(`@${UseGuards.name}() requires at least one guard`)
  }

  return defineClassOrMemberDecorator(
    (target, context) => configureRouter(context, target, spec => spec.guards(guards)),
    context => configureRoute(context, spec => spec.guards(guards)),
  )
}
