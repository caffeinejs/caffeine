import type { WebApplication } from '@caffeinejs/http'
import type { AdapterTypes } from '@caffeinejs/http/fastify'

/** The application a client drives, whichever way it got one: a Fastify one. */
export type TestApplication = WebApplication<AdapterTypes>

export interface Fetchable {
  fetch(request: Request): Promise<Response>
}

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
