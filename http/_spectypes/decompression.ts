import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { DecompressionConfig } from '../core/compress/decompression.js'

/** The `decompression()` plugin's block. */
export const DecompressionConfigSchema = $t.Object({
  encodings: $t.Optional($t.List($t.UnionEnum(['zstd', 'br', 'gzip', 'deflate']))),
})

type _Satisfies = SchemaSatisfies<DecompressionConfig, InferConfig<typeof DecompressionConfigSchema>>
