import { readByPath } from './materializer.js'
import type { ConfigSnapshot } from './types.js'

export interface ConfigDiagnostics {
  originOf(path: string): string | undefined
  valueAt(path: string): unknown
  readonly snapshot: ConfigSnapshot
}

export function createConfigDiagnostics<T>(validated: T, snapshot: ConfigSnapshot): ConfigDiagnostics {
  return {
    originOf(path: string) {
      return snapshot.values.get(path)?.origin
    },
    valueAt(path: string) {
      return readByPath(validated, path)
    },
    snapshot,
  }
}
