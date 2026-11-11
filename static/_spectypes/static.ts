import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { StaticOptions } from '../config.js'

/** One mount: its root and the data members of `MountOptions`. `headers` is a function and stays in code. */
const mountSchema = $t.Object({
  root: $t.String(),
  prefix: $t.Optional($t.String()),
  anonymous: $t.Optional($t.Boolean()),
  mode: $t.Optional($t.UnionEnum(['manifest', 'scan'])),
  index: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
  unrouted: $t.Optional($t.Array($t.String())),
  cacheControl: $t.Optional($t.String()),
  immutableMaxAge: $t.Optional($t.Duration()),
  immutable: $t.Optional($t.Array($t.String())),
})

/**
 * The schema of the static files configuration block, satisfying {@link StaticOptions}. Hand the node to
 * `staticFiles((s, { config }) => s.config(...))`.
 */
export const StaticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(mountSchema)),
})

type _Satisfies = SchemaSatisfies<StaticOptions, InferConfig<typeof StaticConfigSchema>>
