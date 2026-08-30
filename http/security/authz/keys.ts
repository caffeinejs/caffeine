import { token } from '@caffeinejs/di'
import type { AuthorizationOptions } from './authz.js'
import type { AuthzRequirement, AuthzRequirementHandler, PolicyEvaluator } from './policy.js'

export const kAuthzOpts = token<AuthorizationOptions>(Symbol('caffeinejs.authorization.options'))
export const kAuthzEvaluators = token<Map<string, PolicyEvaluator>>(Symbol('caffeinejs.authorization.evaluators'))
export const kAuthzHandlers = token<Map<string, AuthzRequirementHandler<AuthzRequirement>>>(
  Symbol('caffeinejs.authorization.handlers'),
)
