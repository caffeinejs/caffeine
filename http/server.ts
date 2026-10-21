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

  /** Answers `request` as it would one off the network, whether or not it is listening. */
  fetch(request: Request | string | URL, options?: RequestInit): Promise<Response>
}
