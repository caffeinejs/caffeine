import type { ListenOptions, Server as NetServer } from 'node:net'

import type { Logger } from '@caffeinejs/application/logger'
import type { Container, ContextKey } from '@caffeinejs/di'
import inject from 'light-my-request'

import type {
  AdapterFactory,
  AdapterFactoryIn,
  AdapterIn,
  IAdapter,
  IAdapterServer,
  ServerAddress,
} from '../../adapter.js'
import type { WebRunInfo } from '../../application.js'
import { bindContext, buildEngine } from '../../core/server/adapter.js'
import type { Context, EngineContextTypes } from '../../core/server/context.js'
import type { ServerPlatform } from '../../core/server/platform.js'
import type { HTTPServer } from '../../core/server/server.js'
import {
  closeServer,
  destroyConnections,
  serverAddress,
  trackConnections,
  type NodeHTTPServer,
  type OpenConnections,
} from './connections.js'
import { fetchInProcess } from './inject.js'
import { createNodePlatform, serveNode, type NodeContextPlatform, type NodeResponse } from './platform.js'
import { resolveNodeServerSettings, type NodeServerSettings } from './settings.js'

/**
 * The Node application's adapter types. They are not in `AdapterRegistry`, so a plain `IContext` keeps Fastify's
 * types.
 */
export interface NodeAdapterTypes extends EngineContextTypes {
  instance: NodeHTTPServer
  request: Context
  platform: NodeContextPlatform
  serverOptions: NodeServerSettings
  runArgs: [options?: ListenOptions]
  runInfo: WebRunInfo
}

type NodePlatform = ServerPlatform<NodeResponse, NodeContextPlatform, void>

/** The adapter of the Node application, which serves the web-standards engine on a Node server. */
export function nodeAdapterFactory(): AdapterFactory<NodeAdapterTypes> {
  return kit => new NodeAdapter(kit)
}

class NodeAdapter implements IAdapter<NodeAdapterTypes> {
  readonly #container: Container
  readonly #contextKey: ContextKey<Context>

  constructor(kit: AdapterFactoryIn) {
    this.#container = kit.container
    this.#contextKey = bindContext(kit.container)
  }

  async setup(input: AdapterIn<NodeAdapterTypes>): Promise<IAdapterServer<NodeAdapterTypes>> {
    const { engine: settings, listen, createServer } = resolveNodeServerSettings(input.server)
    const engine = buildEngine(this.#container, this.#contextKey, input.routeGroups, input, settings, true)
    await engine.ready()
    const platform = createNodePlatform(input.context.logger)
    const server = createServer((_req, res) => serveNode(engine, platform, res, false))
    // Tracked first, as the Fastify adapter does: a callback may make the server listen, and every connection it then
    // accepts must be one a close can end.
    const open = trackConnections(server)

    try {
      await input.customize?.(input.context, server)
    } catch (err) {
      destroyConnections(open)
      await stopListening(server)
      throw err
    }

    return new NodeServer(server, engine, platform, listen, open, input.context.logger)
  }
}

/** One server the Node adapter built. */
class NodeServer implements IAdapterServer<NodeAdapterTypes> {
  readonly #server: NodeHTTPServer
  readonly #engine: HTTPServer
  readonly #platform: NodePlatform
  readonly #listen: ListenOptions | undefined
  readonly #open: OpenConnections
  readonly #logger: Logger

  constructor(
    server: NodeHTTPServer,
    engine: HTTPServer,
    platform: NodePlatform,
    listen: ListenOptions | undefined,
    open: OpenConnections,
    logger: Logger,
  ) {
    this.#server = server
    this.#engine = engine
    this.#platform = platform
    this.#listen = listen
    this.#open = open
    this.#logger = logger
  }

  get instance(): NodeHTTPServer {
    return this.#server
  }

  get address(): ServerAddress | undefined {
    return serverAddress(this.#server)
  }

  request(input: Request | string | URL, options?: RequestInit): Promise<Response> {
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
  async run(options?: ListenOptions): Promise<void> {
    // A fresh object every call: `listen()` writes into what it is handed.
    const merged: ListenOptions = { ...this.#listen, ...options }

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
    )
  }

  /** Cuts every connection and every request still in flight. Called only once the shutdown budget is spent. */
  forceTeardown(): Promise<void> {
    destroyConnections(this.#open)
    this.#engine.forceClose()
    return Promise.resolve()
  }
}

/** Stops `server` listening: resolves once it has, or at once when it was not, whatever error Node passes. */
function stopListening(server: NetServer): Promise<void> {
  return new Promise<void>(resolve => {
    server.close(() => resolve())
  })
}
