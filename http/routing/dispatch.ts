import type { ParameterPickOptions } from '@caffeinejs/std/framework'

/** The function a route ultimately calls, with the picked arguments spread into it. */
export type RouteInvoker = (...args: unknown[]) => unknown

/**
 * The parameter compilers the adapter owns, handed to a route source so it can build its own dispatch without
 * knowing how arguments are picked out of a request.
 */
export interface RouteCompilers<REQ = unknown, RES = unknown> {
  /** Compiles the pickers around `fn`, returning the function the adapter installs as the route handler. */
  handler(parameters: ParameterPickOptions<REQ>[], fn: RouteInvoker): (req: REQ, res: RES) => unknown

  /** Compiles the pickers alone, for a source that resolves its target per request and invokes it itself. */
  args(parameters: ParameterPickOptions<REQ>[]): (req: REQ, res: RES) => unknown[] | Promise<unknown[]>
}

/**
 * Builds a route's dispatch function.
 *
 * Called once, while routes are being registered, and never again. A source with several invocation shapes —
 * a singleton instance, one resolved per request, a plain function — chooses between them here, so the request
 * path never branches on which source declared the route.
 */
export type RouteDispatch<REQ = unknown, RES = unknown>
  = (compilers: RouteCompilers<REQ, RES>) => (req: REQ, res: RES) => unknown

/**
 * A request hook covering every route of one group, supplied by the source that built it.
 *
 * Registered by the adapter exactly as given, so it costs what the equivalent hand-written hook costs.
 */
export type RouteGroupHook<REQ = unknown, RES = unknown>
  = (req: REQ, res: RES, done: (err?: Error) => void) => void
