import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { ViewOptions } from '../view.js'

/**
 * The schema of one view engine's configuration block, satisfying {@link ViewOptions}. Hand the node to
 * `view(v => v.add((e, ...) => e.config(...)))` through the plugin's configure callback.
 *
 * The engine is a module, not data, so it is named in code. `defaultContext` and `options` are carried through
 * untouched: their keys are the templates' and the engine's.
 */
export const ViewConfigSchema = $t.Object({
  root: $t.Optional($t.String()),
  viewExt: $t.Optional($t.String()),
  layout: $t.Optional($t.String()),
  charset: $t.Optional($t.String()),
  production: $t.Optional($t.Boolean()),
  includeViewExtension: $t.Optional($t.Boolean()),
  maxCache: $t.Optional($t.Integer({ minimum: 0 })),
  defaultContext: $t.Optional($t.Record($t.String(), $t.Unknown())),
  options: $t.Optional($t.Record($t.String(), $t.Unknown())),
})

type _Satisfies = SchemaSatisfies<ViewOptions, InferConfig<typeof ViewConfigSchema>>
