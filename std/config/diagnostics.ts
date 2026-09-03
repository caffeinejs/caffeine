import type { ConfigSliceFailure } from './errors.js'
import { readByPath } from './materializer.js'
import { isSecretPath, redact } from './secrets.js'
import type { ConfigEntry, ConfigSnapshot, ConfigValue } from './types.js'

export interface ConfigDiagnostics {
  originOf(path: string): string | undefined
  /** The value at `path`, with anything marked `$t.Secret` replaced by `[redacted]`. */
  valueAt(path: string): unknown
  /**
   * The resolved sources and merged values, secrets redacted.
   *
   * Redacted because this is the one thing here built to be dumped whole — to a log line, a debug endpoint, a
   * crash report — and a secret that survives that trip is a secret in a log.
   */
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
  secrets: ReadonlySet<string> = new Set(),
): ConfigDiagnostics {
  // Built on demand and then kept: most callers never touch the snapshot, and the ones that do tend to dump it
  // more than once.
  let redactedSnapshot: ConfigSnapshot | undefined

  return {
    originOf(path: string) {
      // Where a value came from is not the value. `env:JWT_SECRET` is exactly what someone debugging needs.
      return snapshot.values.get(path)?.origin
    },
    valueAt(path: string) {
      return redact(secrets, path, readByPath(validated, path))
    },
    get snapshot(): ConfigSnapshot {
      if (secrets.size === 0) {
        return snapshot
      }
      redactedSnapshot ??= redactSnapshot(snapshot, secrets)
      return redactedSnapshot
    },
    sliceErrors,
  }
}

function redactSnapshot(snapshot: ConfigSnapshot, secrets: ReadonlySet<string>): ConfigSnapshot {
  return {
    sources: snapshot.sources.map(source => ({
      name: source.name,
      entries: redactEntries(source.entries, secrets),
    })),
    values: redactEntries(snapshot.values, secrets),
  }
}

function redactEntries(
  entries: ReadonlyMap<string, ConfigEntry>,
  secrets: ReadonlySet<string>,
): Map<string, ConfigEntry> {
  const out = new Map<string, ConfigEntry>()

  for (const [key, entry] of entries) {
    out.set(
      key,
      isSecretPath(secrets, entry.key)
        ? { ...entry, value: redact(secrets, entry.key, entry.value) as ConfigValue }
        : entry,
    )
  }

  return out
}
