import { redactValue, type SecretPaths } from './redact.js'
import type { SourceState } from './store.js'
import { readPath } from './tree.js'
import type { ConfigExplanation, ConfigExplanationLayer, ConfigLayer, ConfigSourceStatus } from './types.js'

/**
 * Why `parts` has the value it has: every layer that defines it, winner first, and the value in the current
 * snapshot. A value no layer defines came from a schema default. Every value is redacted.
 *
 * @param layers - All layers in merge order, lowest precedence first.
 */
export function explainPath(
  parts: readonly string[],
  current: unknown,
  layers: readonly ConfigLayer[],
  secrets: SecretPaths,
): ConfigExplanation {
  const path = parts.join('.')
  const found: ConfigExplanationLayer[] = []

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    const value = readPath(layer.data, parts)

    if (value !== undefined) {
      found.push({
        layer: layer.name,
        origin: layer.origins?.get(path) ?? layer.name,
        value: redactValue(value, parts, secrets),
      })
    }
  }

  return { path, value: redactValue(readPath(current, parts), parts, secrets), layers: found }
}

export function describeSource(record: SourceState): ConfigSourceStatus {
  return {
    name: record.source.name,
    trigger: record.trigger,
    layers: record.layers.map(layer => layer.name),
    keys: record.keys,
    lastLoadedAt: record.lastLoadedAt,
    lastLoadMs: record.lastLoadMs,
    consecutiveFailures: record.consecutiveFailures,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  }
}
