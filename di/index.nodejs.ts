import { AsyncLocalStorage } from 'node:async_hooks'

import type { Container } from './container_interface.js'
import { setDefaultContextStorage, type ExecutionContext } from './context/context.js'
import { RequestScope } from './internal/core/scope/index.js'
import { bindScope, kScopeName, Scopes } from './scope.js'

export * from './index.js'

setDefaultContextStorage(() => new AsyncLocalStorage<ExecutionContext>())

const requestScopeFactory = (container: Container) => new RequestScope(() => container.contextStorage)
requestScopeFactory[kScopeName] = 'Request'

bindScope(Scopes.REQUEST, requestScopeFactory)
