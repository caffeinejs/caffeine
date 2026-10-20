/**
 * Runs around every request a client sends: handed the request and `next`, it resolves with the response.
 *
 * Set with `BrewOptions.interceptors`, the first listed seeing the request first and the response last. `next` sends
 * the request it is handed through the interceptors after this one: not calling it answers the call without the
 * server, and calling it again sends again.
 *
 * A body can be read once, so a request handed to `next` twice rejects the second time with a `TypeError`: hand it a
 * `request.clone()` on every attempt but the last, which holds a streamed body in memory until both are read. Set a
 * header on `request` itself, since `new Request(request, { headers })` replaces every header it had.
 *
 * A throw rejects the call, and reaches the interceptor before this one as the rejection of its `next`. Once the call's
 * signal aborts, the call has rejected with its reason, whatever an interceptor still waits on: stop on
 * `request.signal`. A response neither returned, read nor cancelled holds its connection until it is collected.
 *
 * An authenticator's follow-up goes through every interceptor again, as a request of its own.
 */
export type Interceptor = (request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>

// The interceptors around `transport`, the first outermost. Each hop is async, so an interceptor that throws rejects the
// `next` the one before it awaits, rather than throwing past it.
export function intercept(
  interceptors: readonly Interceptor[],
  transport: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  const hop =
    (index: number) =>
    async (request: Request): Promise<Response> =>
      index < interceptors.length ? interceptors[index]!(request, hop(index + 1)) : transport(request)

  return hop(0)
}
