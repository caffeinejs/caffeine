import { type Readable } from 'node:stream'
import { type Context } from './context.js'

export type ActionResultTypes
  = | void
    | string
    | Buffer
    | Response
    | Readable
    | ReadableStream
    | ReadonlyArray<unknown>
    | Readonly<Record<string, unknown>>
    | object
    | Responder

export type ActionResult
  = | ActionResultTypes
    | PromiseLike<ActionResultTypes>

export abstract class Responder {
  abstract respond(ctx: Context): ActionResult
}
