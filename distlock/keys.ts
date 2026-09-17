import { token } from '@caffeinejs/di'

import type { Backend } from './backend.js'
import type { DistLock } from './distlock.js'

/**
 * Where the lock service is published. `DistLock` is an interface and has no runtime identity, so this key is
 * how it is injected.
 */
export const kDistLock = token<DistLock>(Symbol('caffeine.distlock'))

/**
 * A convenience key an application can bind its own backend under, then hand to `.backend(kDistLockBackend)`.
 * Nothing resolves it by default.
 */
export const kDistLockBackend = token<Backend>(Symbol('caffeine.distlock.backend'))
