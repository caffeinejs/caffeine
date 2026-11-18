import { createHash } from 'node:crypto'

import type { IncrementalSHA256 } from './_sha256.js'

export function createSHA256(): IncrementalSHA256 {
  return createHash('sha256')
}
