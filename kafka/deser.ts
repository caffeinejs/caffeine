import type { KafkaDeserializers, KafkaMessage } from './config.js'
import { kDeserError } from './symbols.js'

/** A captured deserialization failure, carried on the record via the {@link kDeserError} sentinel. */
export interface DeserError {
  error: unknown
  raw?: Buffer
}

type RawDeserializer = (data?: Buffer, headers?: unknown, message?: unknown) => unknown

// Wraps a deserializer so a throw becomes a sentinel value instead of crashing the stream.
function wrap(inner: RawDeserializer): RawDeserializer {
  return (data, headers, message) => {
    try {
      return inner(data, headers, message)
    } catch (error) {
      return { [kDeserError]: { error, raw: data } satisfies DeserError }
    }
  }
}

/** Wraps the key/value deserializers so failures are caught and surfaced as a sentinel on the record. */
export function wrapDeserializers(deserializers: KafkaDeserializers): KafkaDeserializers {
  const wrapped: KafkaDeserializers = { ...deserializers }
  if (deserializers.value !== undefined) {
    wrapped.value = wrap(deserializers.value as RawDeserializer) as never
  }
  if (deserializers.key !== undefined) {
    wrapped.key = wrap(deserializers.key as RawDeserializer) as never
  }
  return wrapped
}

/** Returns the captured deserialization error if this record's key or value failed to deserialize. */
export function extractDeserError(message: KafkaMessage): DeserError | undefined {
  return readDeserError(message.value) ?? readDeserError(message.key)
}

function readDeserError(candidate: unknown): DeserError | undefined {
  if (candidate !== null && typeof candidate === 'object' && kDeserError in candidate) {
    return (candidate as Record<symbol, DeserError>)[kDeserError]
  }
  return undefined
}
