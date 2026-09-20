import { ErrCaffeineWebApplication } from '../../error/common.js'

/**
 * ErrAuthzPolicyNotFound is thrown when a policy name does not resolve to a registered policy.
 *
 * Raised at start-up for a name written on a route, and at request time for one passed to
 * `AuthorizationService`. Never treated as a denial: a policy that does not exist cannot have an opinion,
 * and answering 403 would make a misspelled name look like a working rule that nobody satisfies.
 */
export class ErrAuthzPolicyNotFound extends ErrCaffeineWebApplication {
  // See ErrAuthSchemeNotFound: the list is optional so this cannot throw while reporting another failure.
  constructor(policy: string, registered?: readonly string[]) {
    super(
      `Cannot evaluate authorization policy "${policy}": no policy is registered under that name` +
        (registered === undefined
          ? ''
          : registered.length > 0
            ? ` (registered: ${registered.map(name => `"${name}"`).join(', ')})`
            : ' (no policies are registered)'),
      'ERR_AUTHZ_POLICY_NOT_FOUND',
    )
    this.name = 'ErrAuthzPolicyNotFound'
  }
}

/**
 * ErrAuthzRequirementHandlerNotFound is thrown when a requirement names a `kind` no handler claims.
 *
 * Start-up only, while a policy is compiled. A requirement nothing can evaluate would otherwise have to
 * be skipped or fail every request, and both make a policy silently mean something other than it says.
 */
export class ErrAuthzRequirementHandlerNotFound extends ErrCaffeineWebApplication {
  constructor(kind: string) {
    super(
      `Cannot compile authorization policy: no handler is registered for requirement kind "${kind}"`,
      'ERR_AUTHZ_REQUIREMENT_HANDLER_NOT_FOUND',
    )
    this.name = 'ErrAuthzRequirementHandlerNotFound'
  }
}

/**
 * ErrAuthzPolicyEmpty is thrown when a policy is registered with no requirement in it.
 *
 * A policy is satisfied when every one of its requirements is, so one with none is satisfied by every caller, the
 * anonymous one included. It reads as a rule on the route that names it and enforces nothing.
 */
export class ErrAuthzPolicyEmpty extends ErrCaffeineWebApplication {
  constructor(policy: string) {
    super(
      `Cannot register authorization policy "${policy}": it has no requirements, so it would allow every caller`,
      'ERR_AUTHZ_POLICY_EMPTY',
    )
    this.name = 'ErrAuthzPolicyEmpty'
  }
}

/**
 * ErrAuthzRequirementHandlerDuplicate is thrown when two requirement handlers claim the same `kind`.
 *
 * Start-up only. One of the two would otherwise evaluate every requirement of that kind, chosen by the order the
 * container happened to list them in.
 */
export class ErrAuthzRequirementHandlerDuplicate extends ErrCaffeineWebApplication {
  constructor(kind: string) {
    super(
      `Cannot register authorization requirement handlers: two handlers claim the requirement kind "${kind}"`,
      'ERR_AUTHZ_REQUIREMENT_HANDLER_DUPLICATE',
    )
    this.name = 'ErrAuthzRequirementHandlerDuplicate'
  }
}

/**
 * ErrAuthorizationRequired is thrown at start-up when routes are protected but authorization is not
 * configured.
 *
 * Authorization installs itself once `.authentication(...)` is configured, so an application that never
 * called it either does not start.
 */
export class ErrAuthorizationRequired extends ErrCaffeineWebApplication {
  constructor() {
    super(
      'Cannot start application: routes are protected but authorization is not configured: call ' +
        '.authorization(authz => ...) or .authentication(auth => ...) on the application builder',
      'ERR_AUTHORIZATION_REQUIRED',
    )
    this.name = 'ErrAuthorizationRequired'
  }
}
