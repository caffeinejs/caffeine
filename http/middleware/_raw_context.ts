import type { IncomingMessage } from 'node:http'

import type { Context } from '../context.js'
import { Keys } from '../symbols.js'

export function rawContext(req: IncomingMessage): Context | undefined {
  return (req as IncomingMessage & { [Keys.CONTEXT]?: Context })[Keys.CONTEXT]
}
