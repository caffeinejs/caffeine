import type { WebApplication } from '@caffeinejs/http'
import type { NodeAdapter } from '@caffeinejs/http-node'

/** The application a client drives, whichever way it got one: a Node one. */
export type TestApplication = WebApplication<never, never, unknown, NodeAdapter>

export type RouterCtor = abstract new (...args: never[]) => object

export type RouterDescriptor = { path: string; prefix?: string }

export type RouteMethods<C extends RouterCtor> = {
  [K in keyof InstanceType<C>]: InstanceType<C>[K] extends (...args: never[]) => unknown
    ? K extends string
      ? K
      : never
    : never
}[keyof InstanceType<C>]

export type HandlerClient = (input?: Request | RequestInit) => Promise<Response>
