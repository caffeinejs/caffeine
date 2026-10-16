import type { IncomingMessage } from 'node:http'

import type { IContext } from '../../context.js'
import { Keys } from '../../symbols.js'

export function rawContext(req: IncomingMessage): IContext | undefined {
  return (req as IncomingMessage & { [Keys.CONTEXT]?: IContext })[Keys.CONTEXT]
}
