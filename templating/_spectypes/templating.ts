import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { TemplatingConfig } from '../caffeine/caffeine.js'

const Settings = $t.Object({
  layout: $t.Optional($t.Union([$t.String(), $t.Literal(false)])),
  cache: $t.Optional($t.Union([$t.Literal(false), $t.Object({ maxEntries: $t.Optional($t.Integer({ minimum: 1 })) })])),
  limits: $t.Optional(
    $t.Object({
      maxAssetSize: $t.Optional($t.Bytes()),
      maxBundleSize: $t.Optional($t.Bytes()),
      maxPartials: $t.Optional($t.Integer({ minimum: 1 })),
      maxOutputSize: $t.Optional($t.Bytes()),
    }),
  ),
})

export const TemplatingConfigSchema = $t.Object({
  default: $t.Optional(Settings),
  named: $t.Optional($t.Record($t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }), Settings)),
})

type _Satisfies = SchemaSatisfies<TemplatingConfig, InferConfig<typeof TemplatingConfigSchema>>
