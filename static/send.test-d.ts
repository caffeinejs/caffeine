import type { StaticContext } from './send.js'

/** `sendFile` reads a request's route: its options are frozen, so a write is a type error, not a throw. */
declare const ctx: StaticContext

// @ts-expect-error -- a request reads a route's options and writes none
ctx.route!.options.constraints = null
