import type { InferConfig, SchemaSatisfies } from '@caffeinejs/application/config'
import { $t } from '@caffeinejs/application/schema'

import type { CompressionConfig } from '../core/compress/compress.js'

const Level = (minimum: number, maximum: number) => $t.Optional($t.Integer({ minimum, maximum }))
const Coding = $t.UnionEnum(['zstd', 'br', 'gzip', 'deflate'])

/** The `compression()` plugin's block. `compressible` is a function, so it stays in code. */
export const CompressionConfigSchema = $t.Object({
  encodings: $t.Optional($t.List(Coding)),
  threshold: $t.Optional($t.Bytes()),
  gzip: $t.Optional($t.Object({ level: Level(1, 9) })),
  deflate: $t.Optional($t.Object({ level: Level(1, 9) })),
  br: $t.Optional($t.Object({ quality: Level(0, 11) })),
  zstd: $t.Optional($t.Object({ level: Level(1, 19) })),
})

type _Satisfies = SchemaSatisfies<CompressionConfig, InferConfig<typeof CompressionConfigSchema>>
