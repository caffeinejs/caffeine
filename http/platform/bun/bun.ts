import { kHosting, type ServerAdapter } from '../../core/server/hosting.js'
import { bunRuntime, type BunServer } from './runtime.js'
import { BunHostedServer } from './server.js'
import { resolveBunServerSettings, type BunListen, type BunServerSettings } from './settings.js'

/** The Bun adapter: what `.server(...)` takes under it, Bun's server once it runs, and what `run(options)` takes. */
export type BunAdapter = ServerAdapter<BunServerSettings, BunServer | undefined, BunListen>

/**
 * Serves the application with `Bun.serve`, as `.server(...)` says, listening once `run()` is called. On Bun alone:
 * another runtime is refused at start-up.
 *
 * ```ts
 * const app = createWebApplication({ config, adapter: bun() }).mount(pets)
 * const { address } = await app.run({ port: 3000 })
 * ```
 *
 * `ctx.platform` is `{ name: 'fetch', runtime: [server] }`, Bun's server first, and `$p.address()` the socket's peer,
 * so `trustProxy` may name proxies by address. A connection idle for 72 seconds is cut, as under `node()`; one whose
 * request is being answered never is, so a handler may stay silent as long as it needs.
 */
export function bun(): BunAdapter {
  return {
    [kHosting]: settings => {
      // Before anything else: a runtime that is not Bun is refused before any plugin factory has run.
      const serve = bunRuntime()
      const resolved = resolveBunServerSettings(settings)

      return {
        settings: resolved.engine,
        nodeMiddleware: false,
        serve: (engine, context, customize) =>
          Promise.resolve(new BunHostedServer(engine, serve, resolved, customize, context.logger)),
      }
    },
  }
}
