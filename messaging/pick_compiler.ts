import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { MessageContext } from './context.js'
import type { Message } from './message.js'

type Extractor = (message: Message, context: MessageContext) => unknown

// Turns one descriptor into an extractor over the portable message (and, for `msg:context`/`msg:attempt`, the
// context). Mirrors HTTP's buildPicker; the two-arg shape parallels HTTP's `(req, res)` pickers.
function buildPicker(p: ParameterPickOptions<Message>): Extractor {
  if (p.picker !== undefined) {
    const picker = p.picker as (message: Message) => unknown
    return message => picker(message)
  }

  const name = p.name

  switch (p.type) {
    case 'msg:context':
      return (_message, context) => context
    case 'msg:attempt':
      return (_message, context) => context.attempt
    case 'msg:message':
      return message => message
    case 'msg:payload':
      return message => message.payload
    case 'msg:headers':
      return message => message.headers
    case 'msg:header':
      return message => message.headers.get(name as string)
    case 'msg:contentType':
      return message => message.contentType
    default:
      throw new Error(`Invalid message parameter type: ${p.type}`)
  }
}

/**
 * Compiles the ordered picker descriptors into a function producing the handler's argument list. With no
 * descriptors the handler receives the message payload as its single argument (equivalent to `[m.payload()]`).
 */
export function compileArgs(
  params: ParameterPickOptions<Message>[] | undefined,
): (message: Message, context: MessageContext) => unknown[] | Promise<unknown[]> {
  if (params === undefined || params.length === 0) {
    return message => [message.payload]
  }

  const extractors = params.map(buildPicker)
  const hasAsync = params.some(p => p.async === true)

  return hasAsync
    ? (message, context) => Promise.all(extractors.map(extract => extract(message, context)))
    : (message, context) => extractors.map(extract => extract(message, context))
}
