import { RouteAuthzOptions } from '../routing/spec.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

/**
 * Protects a route, or every route of a controller.
 *
 * Bare, it asks for the application's default policy — an authenticated caller, unless
 * `authorizeDecoratorDefaultPolicy` says otherwise. Naming only `schemes` asks for the same: schemes choose who
 * authenticates and challenges, they are not a requirement.
 *
 * Declarations add up and none replaces another, on one target or across a controller and its methods: every
 * policy named has to pass and every `roles` list has to be satisfied, a list being satisfied by any one of its
 * roles. A bare `@Authorize()` on the controller therefore still applies to a method that names a policy.
 */
export function Authorize(opts: Omit<RouteAuthzOptions, 'allowAnonymous'> = {}) {
  return defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.authorize(opts)),
    context => configureRoute(context, spec => spec.authorize(opts)),
  )
}
