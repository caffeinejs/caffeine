import type { ParameterPicker, ParameterPickOptions } from '@caffeinejs/std/framework'

import type { KafkaMessage } from './config.js'

/**
 * The built-in Kafka parameter pickers, mirroring the HTTP `$p` catalog. Each factory returns a tagged
 * descriptor; `@KafkaParams(k => [...])` records an ordered array of them, one per handler argument.
 */
export interface KafkaPickers {
  /** The deserialized message value (payload). */
  value(): ParameterPickOptions<KafkaMessage>
  /** The message key. */
  key(): ParameterPickOptions<KafkaMessage>
  /** The whole headers map. */
  headers(): ParameterPickOptions<KafkaMessage>
  /** A single header value by name. */
  header(name: string): ParameterPickOptions<KafkaMessage>
  /** The topic the message came from. */
  topic(): ParameterPickOptions<KafkaMessage>
  /** The partition the message came from. */
  partition(): ParameterPickOptions<KafkaMessage>
  /** The message offset. */
  offset(): ParameterPickOptions<KafkaMessage>
  /** The message timestamp. */
  timestamp(): ParameterPickOptions<KafkaMessage>
  /** The whole {@link KafkaMessage} envelope (headers, topic, key, value, partition, offset, commit). */
  message(): ParameterPickOptions<KafkaMessage>
  /** The {@link KafkaContext} for this delivery (ack/nack, metadata, send). */
  context(): ParameterPickOptions<KafkaMessage>
  /** A custom extractor over the raw message. */
  pick(
    fn: (message: KafkaMessage) => unknown | Promise<unknown>,
    opts?: { async?: boolean },
  ): ParameterPickOptions<KafkaMessage>
}

function value(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:value' }
}

function key(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:key' }
}

function headers(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:headers' }
}

function header(name: string): ParameterPickOptions<KafkaMessage> {
  return { name, type: 'kafka:header' }
}

function topic(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:topic' }
}

function partition(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:partition' }
}

function offset(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:offset' }
}

function timestamp(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:timestamp' }
}

function message(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:message' }
}

function context(): ParameterPickOptions<KafkaMessage> {
  return { type: 'kafka:context' }
}

function pick(
  fn: (message: KafkaMessage) => unknown | Promise<unknown>,
  opts?: { async?: boolean },
): ParameterPickOptions<KafkaMessage> {
  return { type: 'custom', picker: fn as ParameterPicker<KafkaMessage>, async: opts?.async }
}

export const $k: KafkaPickers = {
  value,
  key,
  headers,
  header,
  topic,
  partition,
  offset,
  timestamp,
  message,
  context,
  pick,
}
