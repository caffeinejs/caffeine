import type { IContext } from './context.js'

/** A request reads the options `onRoute` hooks wrote, frozen once they returned: a write is a type error, not a throw. */
declare const ctx: IContext

// @ts-expect-error -- a request reads a route's options and writes none
ctx.route!.options.cors = false
