import { AsyncLocalStorage } from 'node:async_hooks'

import { bindContextStorageFactory, type ExecutionContext } from './context.js'

export * from './index.js'

bindContextStorageFactory(() => new AsyncLocalStorage<ExecutionContext>())
