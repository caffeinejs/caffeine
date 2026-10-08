import { errMessage } from '@caffeinejs/std/framework/err'

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
      errMessage(`Cannot register Kafka listener "${handler}": no topic declared`)
        .solutions('Pass a topic to @KafkaListener, for example @KafkaListener({ topic: "orders" })')
        .reference('@caffeinejs/kafka', ErrKafkaMissingTopic)
        .build(),
      'ERR_KAFKA_MISSING_TOPIC',
    )
    this.name = 'ErrKafkaMissingTopic'
  }
}

/**
 * Thrown when no group id can be resolved for a listener (no per-listener group and no default). Where the group id
 * is set depends on how the listener was declared, so the solutions come from the throw site.
 */
export class ErrKafkaMissingGroupID extends ErrKafka {
  constructor(handler: string, ...solutions: string[]) {
    super(
      errMessage(`Cannot register Kafka listener "${handler}": no group id resolved`)
        .solutions(...solutions)
        .reference('@caffeinejs/kafka', ErrKafkaMissingGroupID)
        .build(),
      'ERR_KAFKA_MISSING_GROUP_ID',
    )
    this.name = 'ErrKafkaMissingGroupID'
  }
}

/** Thrown when a handler is tagged for a kafka instance that was never configured. */
export class ErrKafkaUnknownInstance extends ErrKafka {
  constructor(handler: string, instance: string, configured: string[]) {
    const fixes = [`Declare the instance with .install(Kafka("${instance}", k => k.brokers(...)))`]
    if (configured.length > 0) {
      const names = configured.map(name => `"${name}"`).join(', ')
      fixes.push(`Or reassign the handler with @KafkaHandler({ instance: "..." }) to a configured instance: ${names}`)
    }
    super(
      errMessage(`Cannot start Kafka handler "${handler}": no integration named "${instance}" is configured`)
        .solutions(...fixes)
        .reference('@caffeinejs/kafka', ErrKafkaUnknownInstance)
        .build(),
      'ERR_KAFKA_UNKNOWN_INSTANCE',
    )
    this.name = 'ErrKafkaUnknownInstance'
  }
}

/** Passed to the recoverer when a handler kept calling `ctx.nack()` until the retry budget was exhausted. */
export class ErrKafkaNackExhausted extends ErrKafka {
  constructor(topic: string, attempts: number) {
    super(
      errMessage(`Cannot redeliver message from topic "${topic}": nack retries exhausted after ${attempts} attempts`)
        .reference('@caffeinejs/kafka', ErrKafkaNackExhausted)
        .build(),
      'ERR_KAFKA_NACK_EXHAUSTED',
    )
    this.name = 'ErrKafkaNackExhausted'
  }
}

/**
 * Thrown when the integration is used without a broker address. Where the brokers are set depends on whether the
 * feature or a binder asked, so the solutions come from the throw site.
 */
export class ErrKafkaMissingBrokers extends ErrKafka {
  constructor(...solutions: string[]) {
    super(
      errMessage('Cannot start Kafka integration: no brokers configured')
        .solutions(...solutions)
        .reference('@caffeinejs/kafka', ErrKafkaMissingBrokers)
        .build(),
      'ERR_KAFKA_MISSING_BROKERS',
    )
    this.name = 'ErrKafkaMissingBrokers'
  }
}
