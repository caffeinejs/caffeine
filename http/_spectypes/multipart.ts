import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import { MAX_MULTIPART_DEPTH, snapshotMultipartLimits, type MultipartLimits } from '../core/multipart/limits.js'

const decimal = /^[0-9]+$/

// Preserve the raw input until decoding. TypeBox's numeric conversion turns boolean settings into 0 or 1.
const count = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  $t
    .Transform($t.Unknown({ type: 'integer', minimum, maximum }))
    .Decode(value => {
      if (typeof value === 'number') {
        return value
      }
      if (typeof value === 'string' && decimal.test(value)) {
        return Number(value)
      }
      throw new TypeError('Multipart counts must be numbers or decimal integer text')
    })
    .Encode(value => value)

const size = $t.Optional($t.Bytes({ allOf: [{ pattern: '[1-9]' }] }))
const properties = {
  maxPartSize: size,
  maxFieldSize: size,
  maxBufferedSize: size,
  maxHeaderSize: size,
  maxHeaders: $t.Optional(count(1)),
  maxParts: $t.Optional(count(1)),
  maxFiles: $t.Optional(count(0)),
  maxDepth: $t.Optional(count(0, MAX_MULTIPART_DEPTH)),
} satisfies Record<keyof MultipartLimits, unknown>

/** Limits to pass to the server's `multipart` setting or a multipart route. */
export const MultipartConfigSchema = $t
  .Transform(
    $t.Object(properties, {
      propertyNames: { enum: Object.keys(properties) },
      // Configuration cleaning must retain misspelled keys for the same validation the server applies.
      additionalProperties: $t.Unknown(),
    }),
  )
  .Decode(snapshotMultipartLimits)
  .Encode(limits => limits)

type _Satisfies = SchemaSatisfies<MultipartLimits, InferConfig<typeof MultipartConfigSchema>>
