import type { Container } from '@caffeinejs/di'
import { createWebApplication, fastifyAdapterFactory } from '@caffeinejs/http'
import FastifyCookie from '@fastify/cookie'
import fastify from 'fastify'

/**
 * Starts an application on a real socket for the authentication e2e specs.
 *
 * The specs drive it over HTTP with {@link Browser}, never through `app.fetch()`: an injected request opens no
 * socket, so nothing about header limits, cookie handling or a redirect chain is exercised by one.
 */

function newApplication(container?: Container) {
  const server = fastify()

  // Registered on the server itself, ahead of everything the application installs, so cookies are parsed by the
  // time the authentication gate reads them.
  server.register(FastifyCookie)

  return createWebApplication(fastifyAdapterFactory(server), container === undefined ? {} : { container })
}

export type E2EApplication = ReturnType<typeof newApplication>

export interface RunningApp {
  readonly app: E2EApplication
  /** `http://localhost:<port>` — `localhost`, not the bound address, because cookies are scoped by host name. */
  readonly origin: string
  close(): Promise<void>
}

export interface StartAppOptions {
  /**
   * `0`, the default, takes any free port. A fixed one is needed only where an identity provider has the redirect
   * URI registered, and specs sharing it cannot run side by side.
   */
  port?: number
  /** A container the spec bound its own stores and providers in, before the application initializes it. */
  container?: Container
}

export async function startApp(
  configure: (app: E2EApplication) => unknown,
  options: StartAppOptions = {},
): Promise<RunningApp> {
  const app = newApplication(options.container)

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
