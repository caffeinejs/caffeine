import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { HealthConfig } from '../health/options.js'

/**
 * The schema of the health configuration block, satisfying {@link HealthConfig}. Hand the node to
 * `Health((h, { config }) => h.config(...))` and to `healthProbes(...)`.
 *
 * Every member is optional, and nothing is defaulted here: the resolved defaults are environment-dependent
 * (`isKubernetes`) and are applied once the builder resolves. So the tree carries only what somebody actually set,
 * and absence keeps its meaning instead of being overwritten by a default written into a low band.
 *
 * The budgets are `$t.Duration()`: `HEALTH__INDICATOR_TIMEOUT=5000` or `'5 hours'` fails validation at `bootstrap()`
 * rather than reaching a timer as 0.
 */
export const HealthConfigSchema = $t.Object({
  enabled: $t.Optional($t.Boolean()),
  paths: $t.Optional(
    $t.Object({
      live: $t.Optional($t.String()),
      ready: $t.Optional($t.String()),
      startup: $t.Optional($t.String()),
    }),
  ),
  indicatorTimeout: $t.Optional($t.Duration()),
  probeDeadline: $t.Optional($t.Duration()),
  cacheTtl: $t.Optional($t.Duration()),
  verbose: $t.Optional($t.Boolean()),
  exclude: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<HealthConfig, InferConfig<typeof HealthConfigSchema>>
