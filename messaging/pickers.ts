import type { ParameterPicker, ParameterPickOptions } from '@caffeinejs/std/framework'
import type { Message } from './message.js'

/**
 * The built-in portable parameter pickers, mirroring the HTTP `$p` and Kafka `$k` catalogs but over the portable
 * {@link Message} envelope. Each factory returns a tagged descriptor; `@MessageParams(m => [...])` records an
 * ordered array of them, one per handler argument. Broker-native fields (topic, partition, offset, key,
 * timestamp) are intentionally absent — reach for the binder package's own pickers (`$k`) when you need them.
 */
export interface MessagePickers {
  /** The decoded message payload. */
  payload(): ParameterPickOptions<Message>
  /** The whole headers map. */
  headers(): ParameterPickOptions<Message>
  /** A single header value by name. */
  header(name: string): ParameterPickOptions<Message>
  /** The message content-type, if known. */
  contentType(): ParameterPickOptions<Message>
  /** The whole {@link Message} envelope. */
  message(): ParameterPickOptions<Message>
  /** The {@link MessageContext} for this delivery (ack/nack, attempt, send). */
  context(): ParameterPickOptions<Message>
  /** The 1-based delivery attempt. */
  attempt(): ParameterPickOptions<Message>
  /** A custom extractor over the raw message. */
  pick(
    fn: (message: Message) => unknown | Promise<unknown>,
    opts?: { async?: boolean },
  ): ParameterPickOptions<Message>
}

function payload(): ParameterPickOptions<Message> {
  return { type: 'msg:payload' }
}

function headers(): ParameterPickOptions<Message> {
  return { type: 'msg:headers' }
}

function header(name: string): ParameterPickOptions<Message> {
  return { name, type: 'msg:header' }
}

function contentType(): ParameterPickOptions<Message> {
  return { type: 'msg:contentType' }
}

function message(): ParameterPickOptions<Message> {
  return { type: 'msg:message' }
}

function context(): ParameterPickOptions<Message> {
  return { type: 'msg:context' }
}

function attempt(): ParameterPickOptions<Message> {
  return { type: 'msg:attempt' }
}

function pick(
  fn: (message: Message) => unknown | Promise<unknown>,
  opts?: { async?: boolean },
): ParameterPickOptions<Message> {
  return { type: 'custom', picker: fn as ParameterPicker<Message>, async: opts?.async }
}

export const $m: MessagePickers = {
  payload,
  headers,
  header,
  contentType,
  message,
  context,
  attempt,
  pick,
}
