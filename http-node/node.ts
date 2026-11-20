import type { ListenOptions } from 'node:net'

import type { ServerAdapter } from '@caffeinejs/http'
import { kHosting } from '@caffeinejs/http/platform'

import { destroyConnections, trackConnections, type NodeHTTPServer } from './connections.js'
import { createNodePlatform, serveNode } from './platform.js'
import { NodeServer, stopListening } from './server.js'
import { resolveNodeServerSettings, type NodeServerSettings } from './settings.js'

/** The Node adapter: what `.server(...)` takes under it, Node's server, and what `run(options)` listens with. */
export type NodeAdapter = ServerAdapter<NodeServerSettings, NodeHTTPServer, ListenOptions>

/**
 * Serves the application on node:http, node:https or node:http2, as `.server(...)` says, listening once `run()` is
 * called:
 *
 * ```ts
 * const app = createWebApplication({ config, adapter: node() }).server(() => ({ listen: { port: 3000 } })).mount(pets)
 * const { address } = await app.run()
 * ```
 *
 * `ctx.req.raw` is a `Request` whose URL follows the socket and the `Host` header, while `ctx.req.host` and
 * `ctx.req.protocol` follow `trustProxy`. Narrow `ctx.platform` on `name === 'node'` to reach Node's request and
 * response.
 */
export function node(): NodeAdapter {
  return {
    [kHosting]: settings => {
      const { engine, listen, createServer } = resolveNodeServerSettings(settings)

      return {
        settings: engine,
        serve: async (server, context, customize) => {
          const platform = createNodePlatform(context.logger)
          const http = createServer((_req, res) => serveNode(server, platform, res, false))
          // Tracked first: a callback may make the server listen, and every connection it then accepts must be one a
          // close can end.
          const open = trackConnections(http)

          try {
            await customize(http)
          } catch (err) {
            destroyConnections(open)
            await stopListening(http)
            throw err
          }

          return new NodeServer(http, server, platform, listen, open, context.logger)
        },
      }
    },
  }
}
