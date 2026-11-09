export type { Backend, LockLease } from './backend.js'
export type { DistLockBuilder } from './builder.js'
export { CaffeineDistLock } from './distlock.js'
export type { AcquireOptions, DistLock, Lock, OnceOptions, RunResult, TryWithLockOptions } from './distlock.js'
export {
  ErrDistLock,
  ErrDistLockConfiguration,
  ErrInvalidLockKey,
  ErrLockBackendContract,
  ErrLockBackendTimeout,
  ErrLockLost,
  ErrLockNotAcquired,
  ErrLockReleased,
} from './errors.js'
export type { Campaign, CampaignOptions } from './election/index.js'
export { kDistLock, kDistLockBackend } from './keys.js'
export { DEFAULT_DIST_LOCK_OPTIONS, type DistLockConfig, type DistLockOptions } from './options.js'
export type { LostReason } from './observability/channels.js'
export { DistributedLock, type DistLockConfigurer } from './plugin.js'
export type { StoreOperation, StoreTimeoutBound } from './store_call.js'
