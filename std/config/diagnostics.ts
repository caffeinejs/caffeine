import type { ConfigSliceFailure } from './errors.js'
import { readByPath } from './materializer.js'
import type { ConfigSnapshot } from './types.js'

export interface ConfigDiagnostics {
  originOf(path: string): string | undefined
  valueAt(path: string): unknown
  readonly snapshot: ConfigSnapshot
  /**
   * The features whose configuration failed to resolve on the most recent pass. Empty when everything
   * resolved. After a refresh these are the only features still serving values from an earlier one.
   */
  readonly sliceErrors: readonly ConfigSliceFailure[]
}

export function createConfigDiagnostics<T>(
  validated: T,
  snapshot: ConfigSnapshot,
  sliceErrors: readonly ConfigSliceFailure[] = [],
): ConfigDiagnostics {
  return {
    originOf(path: string) {
      return snapshot.values.get(path)?.origin
    },
    valueAt(path: string) {
      return readByPath(validated, path)
    },
    snapshot,
    sliceErrors,
  }
}
