import type { ListenOptions } from 'node:net'

import { ErrApplicationNotReady } from '@caffeinejs/application'

import { WebApplication, type WebApplicationOptions, type WebRunInfo } from '../../application.js'
import type { ListenerConfigurer } from '../../core/listener/listener.js'
import type { AnyRouter } from '../../core/routing/programmatic/programmatic.js'
import type { RoutesOf } from '../../core/routing/programmatic/types.js'
import { kHosting, type ServerHosting } from '../../core/server/hosting.js'
import type { ServerSettings } from '../../core/server/settings.js'
import type { HTTPSetupContext } from '../../plugin.js'
import type { IServer, ServerConfigurer } from '../../server.js'
import { destroyConnections, trackConnections, type NodeHTTPServer } from './connections.js'
import { createNodePlatform, serveNode } from './platform.js'
import { NodeServer, stopListening } from './server.js'
import { resolveNodeServerSettings, type NodeServerSettings } from './settings.js'

/** A server of the Node application, as `app.listeners` hands it out. */
export interface INodeServer extends IServer {
  /** The node:http, node:https or node:http2 server. */
  readonly instance: NodeHTTPServer
}

/** What `.serverCallback(...)` takes: the setup context, then the server right after it is constructed. */
export type ServerCustomizer<C = unknown> = (
  context: HTTPSetupContext<C>,
  instance: NodeHTTPServer,
) => void | Promise<void>

/**
 * The Node application: served by the web-standards engine on node:http, node:https or node:http2, as `.server(...)`
 * says, and listening once {@link run} is called.
 */
export class NodeWebApplication<ROUTES = never, DEPS = never, C = unknown> extends WebApplication<ROUTES, DEPS, C> {
  readonly #customizers: ServerCustomizer<C>[] = []
  /** The application's own server, once built: what {@link instance} reads. */
  #own: NodeServer | undefined
  /** What the first `run(options)` was given, read as the application's own server starts. */
  #run: { readonly options: ListenOptions | undefined } | undefined

  /**
   * The node:http, node:https or node:http2 server the application built.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built it.
   */
  get instance(): NodeHTTPServer {
    if (this.#own === undefined) {
      throw new ErrApplicationNotReady('reach the server')
    }

    return this.#own.instance
  }

  /**
   * The listeners, each with its Node server as `instance`.
   *
   * @throws ErrApplicationNotReady before {@link ready} has built them.
   */
  override get listeners(): ReadonlyMap<string, INodeServer> {
    // Every server this application builds is a NodeServer, whose view is an INodeServer.
    return super.listeners as ReadonlyMap<string, INodeServer>
  }

  /**
   * Configures the application's own server, as {@link WebApplication.server} does, with Node's sections besides:
   * `listen`, and node:http's, node:https's or node:http2's own options.
   *
   * ```ts
   * .server(({ config }) => ({ listen: config.app.server, http2: true }))
   * ```
   */
  override server(configure: ServerConfigurer<NodeServerSettings, C>): this {
    return super.server(configure as ServerConfigurer<ServerSettings, C>)
  }

  /**
   * Adds a listener, as {@link WebApplication.listener} does, whose settings take Node's sections too:
   *
   * ```ts
   * .listener('admin', (l, { config }) => l.server(() => ({ listen: config.app.admin })).with(healthProbes()))
   * ```
   */
  override listener(name: string, configure?: ListenerConfigurer<C, NodeServerSettings>): this {
    return super.listener(name, configure as ListenerConfigurer<C, ServerSettings> | undefined)
  }

  /**
   * Hands `callback` the setup context and then the Node server, right after it is constructed and before it
   * listens. A listener is never handed over.
   *
   * Calls accumulate and run in call order.
   *
   * ```ts
   * .serverCallback(({ logger }, server) => server.on('connection', () => logger.debug('connection')))
   * ```
   *
   * @throws ErrApplicationStarted when {@link ready} has already started.
   */
  serverCallback(callback: ServerCustomizer<C>): this {
    this.assertConfigurable()
    this.#customizers.push(callback)
    return this
  }

  override mount<const RS extends ReadonlyArray<AnyRouter>>(
    ...routers: RS
  ): NodeWebApplication<ROUTES | RoutesOf<RS[number]>, DEPS | NonNullable<RS[number]['__deps']>, C>
  override mount(...routers: AnyRouter[]): this {
    return super.mount(...routers) as this
  }

  /**
   * Readies the application if needed and starts the server: listen options merged over the `listen` that
   * `.server(...)` returned, these winning key by key. Each listener starts after it, on its own settings alone.
   *
   * Runs once: a second call is refused rather than joined, since it would otherwise lose its listen options.
   *
   * @throws ErrApplicationRunning when `run()` has already been called, whatever became of that call.
   * @throws ErrApplicationClosed once {@link close} has been called, including while `run()` was still booting.
   */
  override run(options?: ListenOptions): Promise<WebRunInfo> {
    // The first call's: a second one is refused, and must not change what the first listens with while it boots.
    this.#run ??= { options }
    // runInfo() is overridden, so what base run() resolves to carries the address of a server that listens.
    return super.run() as Promise<WebRunInfo>
  }

  /** How each server is hosted: on a node:http, node:https or node:http2 server. */
  protected override [kHosting](settings: object, name: string | undefined): ServerHosting {
    const { engine, listen, createServer } = resolveNodeServerSettings(settings)
    const own = name === undefined

    return {
      settings: engine,
      nodeMiddleware: true,
      serve: async (server, context) => {
        const platform = createNodePlatform(context.logger)
        const http = createServer((_req, res) => serveNode(server, platform, res, false))
        // Tracked first: a callback may make the server listen, and every connection it then accepts must be one a
        // close can end.
        const open = trackConnections(http)

        try {
          for (const customize of own ? this.#customizers : []) {
            await customize(context as HTTPSetupContext<C>, http)
          }
        } catch (err) {
          destroyConnections(open)
          await stopListening(http)
          throw err
        }

        const hosted = new NodeServer(
          http,
          server,
          platform,
          listen,
          open,
          context.logger,
          own ? () => this.#run?.options : undefined,
        )

        if (own) {
          this.#own = hosted
        }

        return hosted
      },
    }
  }
}

/**
 * Creates the Node application: served by the web-standards engine on node:http, node:https or node:http2, as
 * `.server(...)` says, and listening once `run()` is called.
 *
 * ```ts
 * const app = createWebApplication({ config }).server(() => ({ listen: { port: 3000 } })).mount(pets)
 * const { address } = await app.run()
 * ```
 *
 * `ctx.req.raw` is a `Request` whose URL follows the socket and the `Host` header, while `ctx.req.host` and
 * `ctx.req.protocol` follow `trustProxy`. Narrow `ctx.platform` on `name === 'node'` to reach Node's request and
 * response.
 */
export function createWebApplication<TConfig = unknown>(
  options?: WebApplicationOptions<TConfig>,
): NodeWebApplication<never, never, TConfig> {
  return new NodeWebApplication(options)
}
