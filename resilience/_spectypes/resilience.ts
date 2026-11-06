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
  // An object, never a bare duration: `…__BACKOFF__TYPE=exponential` and `…__BACKOFF__INITIAL_DELAY=200ms`.
  backoff: $t.Optional(
    $t.Union([
      $t.Object({ type: $t.Literal('fixed'), delay: $t.Duration() }),
      $t.Object({
        type: $t.Literal('exponential'),
        initialDelay: $t.Optional($t.Duration()),
        multiplier: $t.Optional($t.Number({ minimum: 1 })),
        maxDelay: $t.Optional($t.Duration()),
        jitter: $t.Optional($t.Number({ minimum: 0, exclusiveMaximum: 1 })),
      }),
    ]),
  ),
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

const Preset = $t.Object({
  circuitBreaker: $t.Optional(CircuitBreaker),
  retry: $t.Optional(Retry),
  timeLimiter: $t.Optional(TimeLimiter),
  bulkhead: $t.Optional(Bulkhead),
  rateLimiter: $t.Optional(RateLimiter),
})

/**
 * The schema of the resilience configuration block, satisfying {@link ResilienceConfig}. Hand the node to
 * `Resilience((r, { config }) => r.config(...))`.
 *
 * `presets` is a record of presets by name, each holding at most one policy of each kind:
 * `RESILIENCE__PRESETS__INVENTORY__RETRY__MAX_ATTEMPTS=5` sets the retry of preset `inventory`. Every member is
 * optional and nothing is defaulted here: the policies own their defaults. The durations are `$t.Duration()`, so
 * `…__TIMEOUT_DURATION=2s` is two seconds and a bare `2000` fails validation at `bootstrap()`.
 */
export const ResilienceConfigSchema = $t.Object({
  // `$t.List`, so `RESILIENCE__ORDER=circuitBreaker,retry,rateLimiter,timeLimiter,bulkhead` is five kinds.
  order: $t.Optional($t.List($t.UnionEnum(['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead']))),
  presets: $t.Optional($t.Record($t.String(), Preset)),
})

type _Satisfies = SchemaSatisfies<ResilienceConfig, InferConfig<typeof ResilienceConfigSchema>>
