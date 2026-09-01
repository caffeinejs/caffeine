import { controllerClient } from './controller_client.js'
import { ErrFetchFailed } from './error.js'
import type { Fetchable, HandlerClient, RouteMethods, RouterCtor } from './types.js'

export type ControllerTypedTestClient<C extends RouterCtor> = {
  [H in RouteMethods<C>]: (input?: Request | RequestInit) => Promise<
    InstanceType<C>[H] extends (...args: never[]) => infer R ? Awaited<R> : never
  >
}

export function controllerTypedClient<C extends RouterCtor>(
  routerRef: C,
  target: string | URL | Fetchable,
): ControllerTypedTestClient<C> {
  const raw = controllerClient(routerRef, target)
  const typed: Record<string | symbol, (input?: Request | RequestInit) => Promise<unknown>> = {}

  for (const key of Object.keys(raw as object)) {
    const handler = (raw as Record<string, HandlerClient>)[key]

    typed[key] = async (input?: Request | RequestInit) => {
      const res = await handler(input)
      const contentType = res.headers.get('content-type') ?? ''
      const hasBody = res.body !== null
      const body = hasBody
        ? contentType.toLowerCase().includes('application/json')
          ? await res.json()
          : await res.text()
        : undefined

      if (!res.ok) {
        throw new ErrFetchFailed(
          `${key}: ${res.status} ${res.statusText}`,
          res.status,
          res.headers,
          body,
        )
      }

      return body
    }
  }

  return typed as ControllerTypedTestClient<C>
}
