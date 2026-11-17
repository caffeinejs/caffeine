import type { ListenOptions, Server as NetServer } from 'node:net'

import { ErrApplicationClosed } from '@caffeinejs/application'
import type { Logger } from '@caffeinejs/application/logger'
import inject from 'light-my-request'

import type { HostedServer } from '../../core/server/hosting.js'
import type { HTTPServer } from '../../core/server/server.js'
import type { ServerAddress } from '../../server.js'
import {
  closeServer,
  destroyConnections,
  serverAddress,
  type NodeHTTPServer,
  type OpenConnections,
} from './connections.js'
import { fetchInProcess } from './inject.js'
import type { INodeServer } from './node.js'
import { serveNode, type NodePlatform, type NodeResponse } from './platform.js'

/** One server the Node application built. */
export class NodeServer implements HostedServer {
  readonly #server: NodeHTTPServer
  readonly #engine: HTTPServer
  readonly #platform: NodePlatform
  readonly #listen: ListenOptions | undefined
  readonly #open: OpenConnections
  readonly #logger: Logger
  readonly #runOptions: (() => ListenOptions | undefined) | undefined
  // Set once the teardown is over: while it drains, a request is still answered, with the engine's 503.
  #closed = false

  /** @param runOptions - What `run(options)` was given, read as the server starts; `undefined` for a listener. */
  constructor(
    server: NodeHTTPServer,
    engine: HTTPServer,
    platform: NodePlatform,
    listen: ListenOptions | undefined,
    open: OpenConnections,
    logger: Logger,
    runOptions: (() => ListenOptions | undefined) | undefined,
  ) {
    this.#server = server
    this.#engine = engine
    this.#platform = platform
    this.#listen = listen
    this.#open = open
    this.#logger = logger
    this.#runOptions = runOptions
  }

  get instance(): NodeHTTPServer {
    return this.#server
  }

  get address(): ServerAddress | undefined {
    return serverAddress(this.#server)
  }

  request(input: Request | string | URL, options?: RequestInit): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(new ErrApplicationClosed('reach the server'))
    }

    // Served through the Node platform as a socket's request is, and counted toward `close()` only until answered:
    // a body a test never reads cannot hold it.
    return fetchInProcess(
      injection => inject((_req, res) => serveNode(this.#engine, this.#platform, res as NodeResponse, true), injection),
      input,
      options,
    )
  }

  /** As {@link request}: the server listens itself, so a request handed to it here has no connection to keep. */
  fetch(request: Request): Promise<Response> {
    return this.request(request)
  }

  /**
   * Listens on what `run(options)` was given merged over the `listen` settings, the former winning key by key. With
   * no `host` and no `path`, on `localhost`; with nothing at all, also on a port the OS assigns.
   */
  async run(): Promise<void> {
    // A fresh object every call: `listen()` writes into what it is handed.
    const merged: ListenOptions = { ...this.#listen, ...this.#runOptions?.() }

    if (Object.keys(merged).length === 0) {
      merged.port = 0
    }

    if (merged.path == null && merged.host == null) {
      merged.host = 'localhost'
    }

    const server = this.#server as NetServer

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(merged, () => {
        server.off('error', reject)
        resolve()
      })
    })

    const address = this.address
    const where = address === undefined ? '' : address.origin || address.path
    this.#logger.info({ address: where }, `Server listening at ${where}`)
  }

  teardown(): Promise<void> {
    // The engine first: it answers 503 from now on, and resolves once what is in flight has been answered.
    return closeServer(this.#server, this.#open, () =>
      Promise.all([this.#engine.close(), stopListening(this.#server)]).then(() => undefined),
    ).then(() => {
      this.#closed = true
    })
  }

  /** Cuts every connection and every request still in flight. Called only once the shutdown budget is spent. */
  forceTeardown(): Promise<void> {
    this.#closed = true
    destroyConnections(this.#open)
    this.#engine.forceClose()
    return Promise.resolve()
  }

  view(): INodeServer {
    // Read on each access: where the server listens changes as it starts and closes.
    const address = (): ServerAddress | undefined => this.address

    return {
      instance: this.#server,
      get address() {
        return address()
      },
      request: (request, options) => this.request(request, options),
      fetch: request => this.fetch(request),
    }
  }
}

/** Stops `server` listening: resolves once it has, or at once when it was not, whatever error Node passes. */
export function stopListening(server: NetServer): Promise<void> {
  return new Promise<void>(resolve => {
    server.close(() => resolve())
  })
}
