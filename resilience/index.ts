export { exponential, type Backoff, type ExponentialOptions } from './backoff.js'
export { compose, decorate, type DecorateOptions, run } from './compose.js'
export {
  ErrCallRefused,
  type ErrorClass,
  type ErrorMatcher,
  ErrInvalidOption,
  ErrResilience,
  failureOf,
  type ResilienceFailure,
} from './errors.js'
export type {
  CallContext,
  Operation,
  Policy,
  PolicyLike,
  Recovery,
  RecoveryLike,
  RecoveryWrapper,
  Wrapper,
} from './policy.js'
export type { Clock } from './timers.js'
