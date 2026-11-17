import type { Logger } from '@caffeinejs/application/logger'
import { Second } from '@caffeinejs/std/duration'

import { fetchPlatform, type FetchContextPlatform } from '../../core/server/fetch.js'
import { addressOf, FetchServer, IDLE_TIMEOUT, logListening, type HostedServer } from '../../core/server/hosting.js'
import type { ServerPlatform } from '../../core/server/platform.js'
import type { HTTPServer } from '../../core/server/server.js'
import type { ServerAddress } from '../../server.js'
import type { BunServeOptions, BunServer } from './runtime.js'
import { bunListenOptions, type BunListen, type ResolvedBunSettings } from './settings.js'

/**
 * One server the Bun adapter built: what the engine answers without a socket, as under no adapter, and Bun's server
 * from `run()` on, since Bun builds and listens in one call.
 */
export class BunHostedServer implements HostedServer<BunServer | undefined, BunListen> {
  readonly #engine: HTTPServer
  /** Answers `request()`, and closes the engine. */
  readonly #inProcess: FetchServer
  readonly #serve: (options: BunServeOptions) => BunServer
  readonly #settings: ResolvedBunSettings
  readonly #customize: (instance: BunServer) => Promise<void>
  readonly #logger: Logger
  #server: BunServer | undefined
  /** The Unix socket `run()` bound, `undefined` on a TCP bind. */
  #unix: string | undefined
  #stopped = false

  constructor(
    engine: HTTPServer,
    serve: (options: BunServeOptions) => BunServer,
    settings: ResolvedBunSettings,
    customize: (instance: BunServer) => Promise<void>,
    logger: Logger,
  ) {
    this.#engine = engine
    this.#inProcess = new FetchServer(engine)
    this.#serve = serve
    this.#settings = settings
    this.#customize = customize
    this.#logger = logger
  }

  get instance(): BunServer | undefined {
    return this.#server
  }

  get address(): ServerAddress | undefined {
    if (this.#server === undefined || this.#stopped) {
      return undefined
    }

    return addressOf(this.#settings.tls === undefined ? 'http' : 'https', this.#unix ?? this.#server.address!)
  }

  request(input: Request | string | URL, options?: RequestInit): Promise<Response> {
    return this.#inProcess.request(input, options)
  }

  /** As {@link request}: the server listens itself, so a request handed to it here has no connection to keep. */
  fetch(request: Request): Promise<Response> {
    return this.request(request)
  }

  /**
   * Listens on what `run(options)` was given merged over the `listen` settings, the former winning key by key. A
   * connection idle for 72 seconds is cut; one whose request is being answered never is, while a streamed answer that
   * stays silent for as long is.
   */
  async run(options: BunListen | undefined): Promise<void> {
    const listen = bunListenOptions(this.#settings.listen, options)
    // Bun takes whole seconds.
    const idle = Math.floor(IDLE_TIMEOUT / Second)
    // Built once Bun's server exists, before it is handed a request: what `ctx.platform.runtime` holds.
    let runtime: readonly unknown[] = []
    const platform: ServerPlatform<Request, FetchContextPlatform, Response> = {
      ...fetchPlatform,
      // The peer is the socket's, never a header's: what `trustProxy` by address decides on.
      remoteAddress: request => this.#server?.requestIP(request)?.address,
      // The idle cut comes back as the answer is handed over: Bun drops a request's own timeout once it completes.
      respond: (request, head, payload, hooks) => {
        this.#server?.timeout(request, idle)
        return fetchPlatform.respond(request, head, payload, hooks)
      },
    }
    const engine = this.#engine

    const server = this.#serve({
      ...listen,
      ...(this.#settings.tls === undefined ? {} : { tls: this.#settings.tls }),
      idleTimeout: idle,
      fetch: (request, bun) => {
        // Never cut while the request is answered, however long the handler is silent.
        bun.timeout(request, 0)
        return engine.serve(platform, request, runtime)
      },
    })
    runtime = Object.freeze([server])
    this.#server = server
    this.#unix = listen.unix

    try {
      await this.#customize(server)
    } catch (err) {
      this.#server = undefined
      // The callback's failure is the one to report: a failure to stop must not replace it.
      await server.stop(true).catch(() => undefined)
      throw err
    }

    logListening(this.#logger, this.address)
  }

  async teardown(): Promise<void> {
    try {
      // The engine first: it answers 503 from now on, and resolves once what is in flight has been answered.
      await Promise.all([this.#inProcess.teardown(), this.#server?.stop(false)])
    } finally {
      this.#stopped = true
    }
  }

  /** Cuts every connection and every request still in flight. Called only once the shutdown budget is spent. */
  async forceTeardown(): Promise<void> {
    this.#stopped = true
    await this.#inProcess.forceTeardown()
    // Nothing waits on a forced stop: a failure of it must not surface as an unhandled rejection.
    void this.#server?.stop(true).catch(() => undefined)
  }
}
