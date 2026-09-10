import type { ConfigDiagnostics, ConfigEntry, ConfigSliceFailure, ConfigSnapshot, ConfigValue } from './config.js'
import { readByPath } from './materializer.js'
import { isSecretPath, redact } from './secrets.js'

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
