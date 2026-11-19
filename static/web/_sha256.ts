import { sha256 } from '@noble/hashes/sha2.js'

export interface IncrementalSHA256 {
  update(chunk: Uint8Array): void
  digest(): Uint8Array
}

export function createSHA256(): IncrementalSHA256 {
  return sha256.create()
}
