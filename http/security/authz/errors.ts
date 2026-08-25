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
      `Cannot evaluate authorization policy "${policy}": no policy is registered under that name`
      + (registered === undefined
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
