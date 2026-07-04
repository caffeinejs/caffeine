import type { Router } from '@caffeinejs/application'

export interface Fetchable {
  fetch(request: Request): Promise<Response>
}

export type RouterCtor = abstract new (...args: never[]) => object

export type RouterDescriptor = Exclude<Router<unknown>, 'key' | 'binding' | 'controller'>

export type RouteMethods<C extends RouterCtor> = {
  [K in keyof InstanceType<C>]: InstanceType<C>[K] extends (...args: never[]) => unknown
    ? K extends string ? K : never
    : never
}[keyof InstanceType<C>]

export type HandlerClient = (input?: Request | RequestInit) => Promise<Response>

export type TestClient<C extends RouterCtor> = {
  [H in RouteMethods<C>]: HandlerClient
}

export type TypedTestClient<C extends RouterCtor> = {
  [H in RouteMethods<C>]: (input?: Request | RequestInit) => Promise<
    InstanceType<C>[H] extends (...args: never[]) => infer R ? Awaited<R> : never
  >
}
