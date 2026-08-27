/** The default instance name used when a kafka integration is declared without an explicit name. */
export const DEFAULT_INSTANCE = 'default'

/**
 * Well-known label/tag symbols for the Kafka integration.
 *
 * - `KAFKA_HANDLER` labels every `@KafkaHandler` class (discovery, like the HTTP `CONTROLLER` label).
 * - `KAFKA_CONTAINER` labels every per-instance `KafkaListenerContainer` so the plugin can start/stop them all.
 * - `KAFKA_INSTANCE` tags a handler class with the name of the instance it belongs to.
 */
export const Keys = {
  KAFKA_HANDLER: Symbol.for('@caffeinejs/kafka:handler'),
  KAFKA_CONTAINER: Symbol.for('@caffeinejs/kafka:container'),
  KAFKA_INSTANCE: Symbol.for('@caffeinejs/kafka:instance'),
}

/**
 * Internal key for the engine-facing ack/nack/attempt state carried on a `KafkaContext`. Kept off the
 * documented public surface so `KafkaContext` stays a single class the runtime engine can read from.
 */
export const kSignals = Symbol('@caffeinejs/kafka:context-signals')

/**
 * Marks the sentinel a wrapped deserializer returns when the real deserializer throws, so a deserialization
 * failure travels on the record itself (as `message.value`/`message.key`) — no offset-keyed side channel.
 */
export const kDeserError = Symbol('@caffeinejs/kafka:deser-error')

/**
 * Wire header names stamped on a record as it travels through the non-blocking retry topics. These are data on
 * the message (RFC-style `x-` tokens), read by the retry consumers to resume the retry journey — kept literal
 * (not acronym-cased identifiers) because they are the on-the-wire contract.
 *
 * - `ORIGINAL_TOPIC` — the source topic a retry record originated from (routing key on retry topics).
 * - `ATTEMPT` — the 1-based delivery attempt the retry consumer should treat this record as.
 * - `NOT_BEFORE` — epoch-ms floor; the retry consumer blocks until this time before invoking (the delay tier).
 */
export const RetryHeaders = {
  ORIGINAL_TOPIC: 'x-original-topic',
  ATTEMPT: 'x-retry-attempt',
  NOT_BEFORE: 'x-retry-not-before',
} as const

/**
 * The DI key of the `KafkaTemplate` for a named instance. The default instance's template is also bound under
 * the `KafkaTemplate` class itself (this symbol is a name alias on it), so default users may inject either.
 * Named-instance users inject via this key: `@Inject(kafkaTemplate('orders'))`.
 */
export function kafkaTemplate(name: string = DEFAULT_INSTANCE): symbol {
  return Symbol.for(`@caffeinejs/kafka:template:${name}`)
}

/** Internal: the DI key of the runtime seam for a named instance. */
export function runtimeKey(name: string): symbol {
  return Symbol.for(`@caffeinejs/kafka:runtime:${name}`)
}

/** Internal: the DI key of the listener-container engine for a named instance. */
export function containerKey(name: string): symbol {
  return Symbol.for(`@caffeinejs/kafka:engine:${name}`)
}
