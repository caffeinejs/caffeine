import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { ResilienceConfig } from '../aop/feature.js'

const CircuitBreaker = $t.Object({
  failureRateThreshold: $t.Optional($t.Number({ exclusiveMinimum: 0, maximum: 100 })),
  slowCallRateThreshold: $t.Optional($t.Number({ exclusiveMinimum: 0, maximum: 100 })),
  slowCallDurationThreshold: $t.Optional($t.Duration()),
  slidingWindow: $t.Optional(
    $t.Union([
      $t.Object({ type: $t.Literal('count'), size: $t.Integer({ minimum: 1 }) }),
      $t.Object({ type: $t.Literal('time'), duration: $t.Duration() }),
    ]),
  ),
  minimumNumberOfCalls: $t.Optional($t.Integer({ minimum: 1 })),
  waitDurationInOpenState: $t.Optional($t.Duration()),
  permittedNumberOfCallsInHalfOpenState: $t.Optional($t.Integer({ minimum: 1 })),
  maxWaitDurationInHalfOpenState: $t.Optional($t.Duration()),
  automaticTransitionFromOpenToHalfOpen: $t.Optional($t.Boolean()),
  captureStackTrace: $t.Optional($t.Boolean()),
})

const Retry = $t.Object({
  maxAttempts: $t.Optional($t.Integer({ minimum: 1 })),
  backoff: $t.Optional($t.Duration()),
  failAfterMaxAttempts: $t.Optional($t.Boolean()),
})

const TimeLimiter = $t.Object({
  timeoutDuration: $t.Optional($t.Duration()),
})

const Bulkhead = $t.Object({
  maxConcurrentCalls: $t.Optional($t.Integer({ minimum: 1 })),
  maxWaitDuration: $t.Optional($t.Duration()),
  maxQueuedCalls: $t.Optional($t.Integer({ minimum: 0 })),
  captureStackTrace: $t.Optional($t.Boolean()),
})

const RateLimiter = $t.Object({
  limitForPeriod: $t.Optional($t.Integer({ minimum: 1 })),
  limitRefreshPeriod: $t.Optional($t.Duration()),
  maxWaitDuration: $t.Optional($t.Duration()),
  captureStackTrace: $t.Optional($t.Boolean()),
})

/**
 * The schema of the resilience configuration block, satisfying {@link ResilienceConfig}. Hand the node to
 * `Resilience((r, { config }) => r.config(...))`.
 *
 * Each kind is a record of named instances: `RESILIENCE__RETRIES__INVENTORY__MAX_ATTEMPTS=5` defines the retry
 * `inventory`. Every member is optional and nothing is defaulted here: the strategies own their defaults. The
 * durations are `$t.Duration()`, so `…__TIMEOUT_DURATION=2s` is two seconds and a bare `2000` fails validation at
 * `bootstrap()`.
 */
export const ResilienceConfigSchema = $t.Object({
  circuitBreakers: $t.Optional($t.Record($t.String(), CircuitBreaker)),
  retries: $t.Optional($t.Record($t.String(), Retry)),
  timeLimiters: $t.Optional($t.Record($t.String(), TimeLimiter)),
  bulkheads: $t.Optional($t.Record($t.String(), Bulkhead)),
  rateLimiters: $t.Optional($t.Record($t.String(), RateLimiter)),
})

type _Satisfies = SchemaSatisfies<ResilienceConfig, InferConfig<typeof ResilienceConfigSchema>>
