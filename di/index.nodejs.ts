import { AsyncLocalStorage } from 'node:async_hooks'
import { RequestScope } from './internal/core/scope/index.js'
import { bindScope, kScopeName, Scopes } from './scope.js'

export * from './index.js'
export { type PathFilter, scan, type ScanOptions, type SinglePathFilter } from './scan/index.js'

const requestScopeFactory = () => new RequestScope(new AsyncLocalStorage())
requestScopeFactory[kScopeName] = 'Request'

bindScope(Scopes.REQUEST, requestScopeFactory)
