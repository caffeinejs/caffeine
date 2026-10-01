import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { MultipartOptions } from './multipart_plugin.js'

/**
 * The schema of the multipart configuration block, satisfying `@fastify/multipart`'s options. Hand the node to
 * the plugin: `.with(({ config }) => multipartPlugin(...))`.
 *
 * Only the limits a deployment tunes are here. `attachFieldsToBody` changes how the upload pickers read a body,
 * so it is code's choice, and the hooks are functions.
 *
 * The sizes are `$t.Bytes()`: `'10MB'` or a number of bytes.
 */
export const MultipartConfigSchema = $t.Object({
  throwFileSizeLimit: $t.Optional($t.Boolean()),
  limits: $t.Optional(
    $t.Object({
      fieldNameSize: $t.Optional($t.Bytes()),
      fieldSize: $t.Optional($t.Bytes()),
      fileSize: $t.Optional($t.Bytes()),
      fields: $t.Optional($t.Integer({ minimum: 0 })),
      files: $t.Optional($t.Integer({ minimum: 0 })),
      headerPairs: $t.Optional($t.Integer({ minimum: 0 })),
      parts: $t.Optional($t.Integer({ minimum: 0 })),
    }),
  ),
})

type _Satisfies = SchemaSatisfies<MultipartOptions, InferConfig<typeof MultipartConfigSchema>>
