import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import type { KafkaContext } from './context.js'
import type { KafkaMessage } from './config.js'

type Extractor = (message: KafkaMessage, context: KafkaContext) => unknown

// Turns one descriptor into an extractor over the Kafka message (and, for `kafka:context`, the context).
// Mirrors HTTP's buildPicker; the two-arg shape parallels HTTP's `(req, res)` pickers.
function buildPicker(p: ParameterPickOptions<KafkaMessage>): Extractor {
  if (p.picker !== undefined) {
    const picker = p.picker as (message: KafkaMessage) => unknown
    return message => picker(message)
  }

  const name = p.name

  switch (p.type) {
    case 'kafka:context':
      return (_message, context) => context
    case 'kafka:message':
      return message => message
    case 'kafka:value':
      return message => message.value
    case 'kafka:key':
      return message => message.key
    case 'kafka:headers':
      return message => message.headers
    case 'kafka:header':
      return message => message.headers.get(name as string)
    case 'kafka:topic':
      return message => message.topic
    case 'kafka:partition':
      return message => message.partition
    case 'kafka:offset':
      return message => message.offset
    case 'kafka:timestamp':
      return message => message.timestamp
    default:
      throw new Error(`Invalid Kafka parameter type: ${p.type}`)
  }
}

/**
 * Compiles the ordered picker descriptors into a function producing the handler's argument list. With no
 * descriptors the handler receives the whole {@link KafkaMessage} (equivalent to `[k.message()]`).
 */
export function compileArgs(
  params: ParameterPickOptions<KafkaMessage>[] | undefined,
): (message: KafkaMessage, context: KafkaContext) => unknown[] | Promise<unknown[]> {
  if (params === undefined || params.length === 0) {
    return message => [message]
  }

  const extractors = params.map(buildPicker)
  const hasAsync = params.some(p => p.async === true)

  return hasAsync
    ? (message, context) => Promise.all(extractors.map(extract => extract(message, context)))
    : (message, context) => extractors.map(extract => extract(message, context))
}
