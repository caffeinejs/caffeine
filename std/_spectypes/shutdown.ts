import type { InferConfig, SchemaSatisfies } from '../config/types.js'
import { $t } from '../schema/t.js'
import type { ShutdownConfig } from '../shutdown/shutdown_options.js'
import { SHUTDOWN_SIGNALS } from '../shutdown/signals.js'

/**
 * The schema of the shutdown configuration block, satisfying {@link ShutdownConfig}.
 *
 * Every member is optional and nothing is defaulted here: the resolved defaults are environment-dependent
 * (`isKubernetes`, the test-runner check) and are applied once the builder resolves. So the tree carries only
 * what somebody actually set, and absence keeps its meaning.
 *
 * The durations are `$t.Duration()`: `SHUTDOWN__SHUTDOWN_TIMEOUT=10000` fails validation at `bootstrap()` rather than
 * becoming a timeout of 0, which waits indefinitely.
 */
export const ShutdownConfigSchema = $t.Object({
  drainDelay: $t.Optional($t.Duration()),
  shutdownTimeout: $t.Optional($t.Duration()),
  terminationGracePeriod: $t.Optional($t.Duration()),
  // `$t.List` rather than `$t.Array`: `SHUTDOWN__SIGNALS=SIGTERM,SIGINT` should be two signals, not one signal
  // with a comma in its name.
  signals: $t.Optional($t.Union([$t.Literal(false), $t.List($t.UnionEnum(SHUTDOWN_SIGNALS))])),
})

type _Satisfies = SchemaSatisfies<ShutdownConfig, InferConfig<typeof ShutdownConfigSchema>>
