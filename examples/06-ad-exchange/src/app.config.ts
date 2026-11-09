import { fileURLToPath } from 'node:url'

import { newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { YAMLConfigSource } from '@caffeinejs/application/config/yaml'
import { $t } from '@caffeinejs/application/schema'

// The options of each policy a preset may set from configuration. Every span of time is text with a unit, such as
// `80ms`: a bare number fails the load.
const CircuitBreakerSchema = $t.Object({
  failureRateThreshold: $t.Optional($t.Number({ minimum: 0, maximum: 100 })),
  slowCallRateThreshold: $t.Optional($t.Number({ minimum: 0, maximum: 100 })),
  slowCallDurationThreshold: $t.Optional($t.Duration()),
  slidingWindow: $t.Optional($t.Object({ type: $t.Literal('count'), size: $t.Integer({ minimum: 1 }) })),
  minimumNumberOfCalls: $t.Optional($t.Integer({ minimum: 1 })),
  waitDurationInOpenState: $t.Optional($t.Duration()),
  permittedNumberOfCallsInHalfOpenState: $t.Optional($t.Integer({ minimum: 1 })),
})

const PresetSchema = $t.Object({
  circuitBreaker: $t.Optional(CircuitBreakerSchema),
  rateLimiter: $t.Optional(
    $t.Object({
      limitForPeriod: $t.Optional($t.Integer({ minimum: 1 })),
      limitRefreshPeriod: $t.Optional($t.Duration()),
    }),
  ),
  timeLimiter: $t.Optional($t.Object({ timeoutDuration: $t.Optional($t.Duration()) })),
  bulkhead: $t.Optional($t.Object({ maxConcurrentCalls: $t.Optional($t.Integer({ minimum: 1 })) })),
  retry: $t.Optional(
    $t.Object({
      maxAttempts: $t.Optional($t.Integer({ minimum: 1 })),
      backoff: $t.Optional(
        $t.Union([
          $t.Object({
            type: $t.Literal('exponential'),
            initialDelay: $t.Optional($t.Duration()),
            maxDelay: $t.Optional($t.Duration()),
          }),
          $t.Object({ type: $t.Literal('fixed'), delay: $t.Duration() }),
        ]),
      ),
    }),
  ),
})

/**
 * The shape of `config/application.yaml`, and of every profile file layered over it.
 *
 * The values live in the files, so the schema declares types and constraints and no defaults: a key the files miss
 * fails the load instead of running on a value nobody wrote down.
 */
export const ConfigSchema = $t.Object({
  // Handed to `.server(...)` as the listen options, so the keys are Fastify's.
  server: $t.Object({
    host: $t.String(),
    port: $t.Number(),
  }),
  log: $t.Object({
    level: $t.String(),
  }),
  exchange: $t.Object({
    // `false` calls every DSP with no policy at all: the baseline the load test compares against.
    resilience: $t.Boolean(),
  }),
  // The DSPs every auction calls, in the order a tie between two equal bids is broken.
  dsps: $t.Array(
    $t.Object({
      id: $t.String({ pattern: '^[a-z0-9-]+$' }),
      url: $t.String(),
      // The requests a second this DSP agreed to take. Without it, nothing limits the rate.
      qps: $t.Optional($t.Integer({ minimum: 1 })),
    }),
    { minItems: 1 },
  ),
  // What `Resilience(r => r.config(...))` reads: the options every DSP's policies start from, and presets by name.
  resilience: $t.Object({
    defaults: PresetSchema,
    presets: $t.Record($t.String(), PresetSchema),
  }),
})

export type Config = InferConfig<typeof ConfigSchema>

/** One DSP, as `dsps` in the configuration lists it. */
export type DSPConfig = Config['dsps'][number]

const conf = newConfiguration(ConfigSchema)
  .source(new YAMLConfigSource(fileURLToPath(new URL('../config/application.yaml', import.meta.url))))
  .build()

/**
 * The configuration the application resolves at `bootstrap()`. Data only: importing this module reads no file, the
 * source reads it when the application loads.
 */
export const configuration = conf.config

/** The key the configuration the application started with is bound under, typed from the schema. */
export const kConfig = conf.configToken

/** The name of the preset that guards the win notices every winning DSP gets. */
export const WIN_NOTICE = 'win-notice'
