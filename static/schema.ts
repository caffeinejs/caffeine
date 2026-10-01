import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { StaticOptions } from './config.js'

/**
 * One mount. Only `root` and `anonymous` are declared: the `@fastify/static` options are not ours, they are
 * numerous, and they move between releases, so a hand-maintained mirror would reject options that work. Every
 * other key is kept and handed to `@fastify/static` as written.
 */
const mountSchema = $t.Object(
  {
    root: $t.Union([$t.String(), $t.Array($t.String())]),
    anonymous: $t.Optional($t.Boolean()),
  },
  { additionalProperties: $t.Unknown() },
)

/**
 * The schema of the static files configuration block, satisfying {@link StaticOptions}. Hand the node to
 * `staticFiles((s, { config }) => s.config(...))`.
 */
export const StaticConfigSchema = $t.Object({
  mounts: $t.Optional($t.Array(mountSchema)),
})

type _Satisfies = SchemaSatisfies<StaticOptions, InferConfig<typeof StaticConfigSchema>>
