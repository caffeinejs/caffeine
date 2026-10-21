import type { AnyAdapterTypes, IAdapterTypes, ServerAddress } from './adapter.js'

/**
 * An HTTP server the application runs: what it is, where it listens and a way to send it a request, but not its
 * lifecycle, which `app.run()` and `app.close()` drive.
 *
 * The {@link WebApplication} is one, for its own server, and so is each of `app.listeners`. `T` is the serving
 * adapter's {@link IAdapterTypes}; left out, it is any registered adapter's.
 */
export interface IServer<T extends IAdapterTypes = AnyAdapterTypes> {
  get instance(): T['instance']

  /** Where the server is listening, or `undefined` while it is not: before it runs, and once it has closed. */
  get address(): ServerAddress | undefined

  /**
   * Answers `request` as it would one off the network, whether or not it is listening: a pass-through, not a client.
   *
   * The request goes as `fetch(request, options)` would send it, `options` applying over a `Request` as they do there,
   * and the answer comes back as the server wrote it: a redirect is neither followed nor refused, whatever `redirect`
   * says, and a compressed body is not decoded. The call settles once the server starts writing, and the body streams
   * as it is written. A request body streams under its own `Content-Length` or `Transfer-Encoding`, as one a server
   * received carries; without either, it is read whole first.
   *
   * An abort rejects the call, or fails the body being read, with the signal's reason, and the handler sees its request
   * close (`ctx.signal`).
   *
   * No socket carries the request: it is seen as `http` from `127.0.0.1`, whatever its URL's scheme. Under a
   * `trustProxy` that trusts loopback, its `X-Forwarded-*` headers decide both, so a runtime handing on the requests it
   * received must not leave a client's own in them.
   *
   * A runtime that calls its handler with a second argument of its own hands on the request alone, or that argument is
   * read as `options`: `Bun.serve({ fetch: request => app.fetch(request) })`.
   */
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
}
