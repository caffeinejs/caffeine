import type { Container } from '@caffeinejs/di'
import { createWebApplication, fastifyAdapterFactory, type WebApplicationOptions } from '@caffeinejs/http'
import type { ConfigDefinition } from '@caffeinejs/std/config'
import FastifyCookie from '@fastify/cookie'
import fastify from 'fastify'

/**
 * Starts an application on a real socket for the authentication e2e specs.
 *
 * The specs drive it over HTTP with {@link Browser}, never through `app.fetch()`: an injected request opens no
 * socket, so nothing about header limits, cookie handling or a redirect chain is exercised by one.
 */

function newApplication<C>(options: StartAppOptions<C>) {
  const server = fastify()

  // Registered on the server itself, ahead of everything the application installs, so cookies are parsed by the
  // time the authentication gate reads them.
  server.register(FastifyCookie)

  // Both type parameters are inferred: the adapter from the factory, the configuration from `options.config`.
  const applicationOptions: WebApplicationOptions<C> = {
    container: options.container,
    config: options.config,
    // Silent: what the application logs is not what these specs are about, and it buries the reporter's output.
    logger: false,
  }

  return createWebApplication(fastifyAdapterFactory(server), applicationOptions)
}

export type E2EApplication<C = unknown> = ReturnType<typeof newApplication<C>>

export interface RunningApp<C = unknown> {
  readonly app: E2EApplication<C>
  /** `http://localhost:<port>` — `localhost`, not the bound address, because cookies are scoped by host name. */
  readonly origin: string
  close(): Promise<void>
}

export interface StartAppOptions<C = unknown> {
  /**
   * `0`, the default, takes any free port. A fixed one is needed only where an identity provider has the redirect
   * URI registered, and specs sharing it cannot run side by side.
   */
  port?: number
  /** A container the spec bound its own stores and providers in, before the application initializes it. */
  container?: Container
  /** The application's configuration, for a spec about what reaches a scheme from a file or the environment. */
  config?: ConfigDefinition<C>
}

export async function startApp<C = unknown>(
  configure: (app: E2EApplication<C>) => unknown,
  options: StartAppOptions<C> = {},
): Promise<RunningApp<C>> {
  const app = newApplication<C>(options)

  app.server(s => s.host('127.0.0.1').port(options.port ?? 0))
  configure(app)

  const { address } = await app.run()
  if (address === undefined) {
    throw new Error('Cannot start the e2e application: the server reported no address')
  }

  return {
    app,
    origin: `http://localhost:${address.port}`,
    close: () => app.close(),
  }
}
