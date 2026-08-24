/**
 * Portable message headers. A `Map` (not WHATWG `Headers`) so binary values survive — Kafka, AMQP and NATS all
 * carry raw byte headers, which `Headers` would coerce to strings. Keys are case-sensitive wire tokens.
 */
export type MessageHeaders = Map<string, string | Buffer>

/**
 * The portable envelope every binder produces and consumes. `payload` is the decoded body; `headers` are the
 * wire metadata; `contentType` (when known) drives (de)serialization. Binder-native extras (Kafka offset/commit,
 * AMQP delivery tag, NATS reply subject) live on the binder's own context type, not here.
 */
export interface Message<T = unknown> {
  payload: T
  headers: MessageHeaders
  contentType?: string
}

/** Options accepted when building a {@link Message} from a bare payload. */
export interface MessageInit {
  headers?: MessageHeaders | Record<string, string | Buffer>
  contentType?: string
}

/** Normalizes headers given as a plain object into the {@link MessageHeaders} map form. */
function toHeaders(headers: MessageHeaders | Record<string, string | Buffer> | undefined): MessageHeaders {
  if (headers === undefined) {
    return new Map()
  }
  if (headers instanceof Map) {
    return headers
  }
  return new Map(Object.entries(headers))
}

/** Builds a portable {@link Message} from a payload and optional headers/content-type. */
export function message<T>(payload: T, init: MessageInit = {}): Message<T> {
  return {
    payload,
    headers: toHeaders(init.headers),
    ...(init.contentType !== undefined ? { contentType: init.contentType } : {}),
  }
}

/** Narrows a `payload | Message` argument (the `MessageBus.send` overload) to a full {@link Message}. */
export function isMessage(value: unknown): value is Message {
  return (
    typeof value === 'object'
    && value !== null
    && 'payload' in value
    && 'headers' in value
    && (value as { headers: unknown }).headers instanceof Map
  )
}
