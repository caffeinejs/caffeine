/** Base error for the Kafka integration. */
export class ErrKafka extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrKafka'
    this.code = code
  }
}

/** Thrown when a `@KafkaListener` method is declared without a topic to subscribe to. */
export class ErrKafkaMissingTopic extends ErrKafka {
  constructor(handler: string) {
    super(
      `Cannot register Kafka listener "${handler}": no topic declared` +
        '\n  - Pass a topic to @KafkaListener, for example @KafkaListener({ topic: "orders" })',
      'ERR_KAFKA_MISSING_TOPIC',
    )
    this.name = 'ErrKafkaMissingTopic'
  }
}

/** Thrown when no group id can be resolved for a listener (no per-listener group and no default). */
export class ErrKafkaMissingGroupID extends ErrKafka {
  constructor(handler: string) {
    super(
      `Cannot register Kafka listener "${handler}": no group id resolved` +
        '\n  - Set a per-listener groupId on @KafkaListener, or a default groupId on the kafka feature config',
      'ERR_KAFKA_MISSING_GROUP_ID',
    )
    this.name = 'ErrKafkaMissingGroupID'
  }
}

/** Thrown when a handler is tagged for a kafka instance that was never configured. */
export class ErrKafkaUnknownInstance extends ErrKafka {
  constructor(handler: string, instance: string, configured: string[]) {
    const known = configured.length > 0 ? configured.map(name => `"${name}"`).join(', ') : '(none)'
    super(
      `Cannot start Kafka handler "${handler}": no integration named "${instance}" is configured` +
        `\n  - Declare the instance with .extend(kafka("${instance}"), k => k.brokers(...))` +
        '\n  - Or reassign the handler to a configured instance with @KafkaHandler({ instance: "..." })' +
        `\n  - Configured instances: ${known}`,
      'ERR_KAFKA_UNKNOWN_INSTANCE',
    )
    this.name = 'ErrKafkaUnknownInstance'
  }
}

/** Passed to the recoverer when a handler kept calling `ctx.nack()` until the retry budget was exhausted. */
export class ErrKafkaNackExhausted extends ErrKafka {
  constructor(topic: string, attempts: number) {
    super(
      `Cannot redeliver message from topic "${topic}": nack retries exhausted after ${attempts} attempts`,
      'ERR_KAFKA_NACK_EXHAUSTED',
    )
    this.name = 'ErrKafkaNackExhausted'
  }
}

/** Thrown when the plugin is used without a broker address. */
export class ErrKafkaMissingBrokers extends ErrKafka {
  constructor() {
    super(
      'Cannot start Kafka integration: no brokers configured' +
        '\n  - Provide at least one broker, for example kafka({ brokers: "localhost:9092" })',
      'ERR_KAFKA_MISSING_BROKERS',
    )
    this.name = 'ErrKafkaMissingBrokers'
  }
}
