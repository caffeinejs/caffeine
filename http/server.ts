import type { HTTPSetupContext } from './plugin.js'

/**
 * Where the server ended up listening, as reported by the bound socket — which is not what was asked for:
 * port `0` becomes an OS-assigned port, and a wildcard host stays a wildcard.
 */
export interface ServerAddress {
  /** The bound host, verbatim — a wildcard bind reports `0.0.0.0` or `::`. `''` on a unix socket or a named pipe. */
  readonly host: string
  /** The bound port. Never `0` on a TCP bind, and `0` on a unix socket or a named pipe. */
  readonly port: number
  /** The unix socket or the named pipe the server is bound to. `''` on a TCP bind. */
  readonly path: string
  /**
   * An origin that can be connected to: `https:` when the server serves TLS, `http:` otherwise. A wildcard
   * {@link host} is rendered as the matching loopback address, since `0.0.0.0` is an address to accept on, not one
   * to dial. `''` on a unix socket or a named pipe, which no URL reaches.
   */
  readonly origin: string
}

/**
 * The callback `.server(configure)` takes: resolves the server's settings against the context a plugin factory gets,
 * less `server`, which these settings describe, so `config` is the resolved tree and the container resolves. `S` is
 * what the application's adapter takes: `ServerSettings` under none, `NodeServerSettings` under `node()`,
 * `BunServerSettings` under `bun()`.
 */
export type ServerConfigurer<S extends object, C = unknown> = (
  context: Omit<HTTPSetupContext<C>, 'server'>,
) => S | Promise<S>

/** What `.serverCallback(...)` takes: the setup context, then the server the adapter built. */
export type ServerCustomizer<C = unknown, I = unknown> = (
  context: HTTPSetupContext<C>,
  instance: I,
) => void | Promise<void>

/**
 * An HTTP server the application runs: where it listens and a way to send it a request, but not its lifecycle,
 * which `app.run()` and `app.close()` drive.
 *
 * The {@link WebApplication} is one, for its own server, and so is each of `app.listeners`.
 */
export interface IServer<I = unknown> {
  /** Where the server is listening, or `undefined` while it is not: before it runs, and once it has closed. */
  get address(): ServerAddress | undefined

  /** What serves it on its runtime: Node's server under `node()`, Bun's under `bun()`, `undefined` under none. */
  readonly instance: I

  /**
   * Sends `request` to this server without a socket, whether or not it is listening: a pass-through, not a client.
   *
   * It takes `fetch`'s arguments but is not `fetch`. The request goes as `fetch(request, options)` would send it,
   * `options` applying over a `Request` as they do there, and the answer comes back as the server wrote it: a redirect
   * is neither followed nor refused, whatever `redirect` says, and a compressed body is not decoded. Only the fields
   * that describe a connection are left out, since none carried it. The call settles once the server starts writing,
   * and the body streams as it is written.
   *
   * A request body streams under its own `Content-Length` or `Transfer-Encoding`, as one a server received carries;
   * without either, it is read whole first and sent under its length, as `fetch` measures it. A request with no body
   * goes under the length `fetch` writes, whatever it declares: `0` for a method that expects a body, such as POST, PUT
   * or PATCH, and none for any other.
   *
   * What `fetch` would refuse to send is refused with a `TypeError`, as `fetch` refuses it: a `Content-Length` that is
   * not a count of bytes, or one beside `Transfer-Encoding`; a body its `Content-Length` does not describe, which is
   * never sent past it; and a body whose stream fails, its failure the `cause`. The call rejects with it, or the
   * answer's body fails with it once the answer is handed over.
   *
   * An abort rejects the call, or fails the body being read, with the signal's reason, and the handler sees its request
   * close (`ctx.signal`).
   *
   * No socket carries the request: it is seen as `http` from `127.0.0.1`, whatever its URL's scheme. Under a
   * `trustProxy` that trusts loopback, its `X-Forwarded-*` headers decide both, so a runtime handing on the requests it
   * received must not leave a client's own in them.
   *
   * A runtime that calls its handler with a second argument of its own hands on the request alone, or that argument is
   * read as `options`: `Bun.serve({ fetch: request => app.request(request) })`.
   *
   * @throws ErrApplicationClosed once the application's close has torn the server down; while it drains, the answer
   * is a 503.
   */
  request(request: Request | string | URL, options?: RequestInit): Promise<Response>

  /**
   * The runtime entry, as a fetch runtime calls it: Bun's and a worker's `fetch`, `Deno.serve`. What the runtime hands
   * after the request reaches `ctx.platform.runtime`.
   *
   * Unlike {@link request}, it takes no `RequestInit`, and the request keeps the connection it came on. A server that
   * listens itself answers it as `request` does. On a server that does not, a streamed body holds `app.close()` until
   * it has been read or cancelled.
   */
  fetch(request: Request, ...runtime: unknown[]): Response | Promise<Response>
}
