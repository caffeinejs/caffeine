import { AsyncLocalStorage } from 'node:async_hooks'
import { RequestScope } from './internal/core/scope/index.js'
import { bindScope, kScopeName, Scopes } from './scope.js'

export * from './index.js'

const requestScopeFactory = () => new RequestScope(new AsyncLocalStorage())
requestScopeFactory[kScopeName] = 'Request'

bindScope(Scopes.REQUEST, requestScopeFactory)
