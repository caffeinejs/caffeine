import {
  createServer as createHTTPServer,
  type RequestListener,
  type ServerOptions as HTTPServerOptions,
} from 'node:http'
import {
  createSecureServer as createHTTP2SecureServer,
  createServer as createHTTP2Server,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type ServerHttp2Session,
  type ServerOptions as HTTP2ServerOptions,
} from 'node:http2'
import { createServer as createHTTPSServer, type ServerOptions as HTTPSServerOptions } from 'node:https'
import type { ListenOptions } from 'node:net'

import { Second } from '@caffeinejs/std/duration'

import { configurationError } from '../../core/server/error.js'
import {
  NODE_SECTIONS,
  resolveServerSettings,
  type ApplicationKind,
  type ResolvedServerSettings,
  type ServerSettings,
} from '../../core/server/settings.js'
import type { NodeHTTPServer } from './connections.js'
import type { NodeResponse } from './platform.js'

/** What `.server(...)` returns on the Node application. */
export interface NodeServerSettings extends Omit<ServerSettings, 'trustProxy'> {
  /**
   * Which peers' `X-Forwarded-Host` and `X-Forwarded-Proto` decide `ctx.req.host` and `ctx.req.protocol`.
   *
   * `true` trusts any peer. A list, or a comma-separated string, names the proxies: each entry an address, a CIDR
   * range, or `loopback`, `linklocal` or `uniquelocal`. The last entry of each header wins. Unset: no peer. A hop
   * count is refused, since it cannot tell a proxy from a client.
   */
  trustProxy?: boolean | string | readonly string[]
  /**
   * Where to listen: node:net's options. `run(options)` merges over them, key by key. With no `host` and no `path`,
   * `localhost`; with nothing at all, also a port the OS assigns.
   */
  listen?: ListenOptions
  /** node:http's server options, for an HTTP/1.1 or HTTPS server. `keepAliveTimeout` defaults to 72 seconds. Refused beside `http2`. */
  http?: HTTPServerOptions
  /** Serves TLS: node:https's options, or the TLS options of an HTTP/2 server. */
  https?: HTTPSServerOptions
  /**
   * Serves HTTP/2: over TLS with `https`, in cleartext without. An object is node:http2's options; `allowHTTP1` needs
   * `https`. A session idle for 72 seconds is closed.
   */
  http2?: boolean | HTTP2Section
}

const NODE_APPLICATION: ApplicationKind = {
  name: 'Node application',
  sections: NODE_SECTIONS,
  peerAddress: true,
}

export interface ResolvedNodeSettings {
  readonly engine: ResolvedServerSettings
  readonly listen: ListenOptions | undefined
  /** Creates the server the sections describe, serving each request with `listener`. */
  readonly createServer: (listener: (req: unknown, res: NodeResponse) => void) => NodeHTTPServer
}

// What Fastify gives a connection kept alive, and an HTTP/2 session, when idle: longer than a load balancer's.
const IDLE_TIMEOUT = 72 * Second

const OBJECT_EXAMPLES: Readonly<Record<string, readonly [string, string]>> = {
  listen: ['net', '{ port: 3000 }'],
  http: ['http', '{ requestTimeout: 30 * Second }'],
  https: ['https', '{ key, cert }'],
}

/** @throws ErrConfiguration for what `resolveServerSettings` refuses, and for a Node section it cannot use. */
export function resolveNodeServerSettings(settings: object): ResolvedNodeSettings {
  const engine = resolveServerSettings(settings, NODE_APPLICATION)
  const { listen, http, https, http2 } = settings as Record<string, unknown>

  for (const [key, value] of Object.entries({ listen, http, https })) {
    if (value !== undefined && !isOptions(value)) {
      const [module, example] = OBJECT_EXAMPLES[key]!
      throw configurationError(
        `Cannot set ${key} to "${String(value)}": it must be an object of node:${module} options`,
        `Return ${key} as an object, such as ${example}`,
      )
    }
  }

  if (http2 !== undefined && typeof http2 !== 'boolean' && !isOptions(http2)) {
    throw configurationError(
      `Cannot set http2 to "${String(http2)}": it must be true, false or an object of node:http2 options`,
      'Write http2: true, or an object such as { allowHTTP1: true }',
    )
  }

  const h2 = http2 === true ? {} : http2 === false || http2 === undefined ? undefined : (http2 as HTTP2Section)

  if (h2 !== undefined && http !== undefined) {
    throw configurationError(
      'Cannot use the http section with http2: an HTTP/2 server takes no node:http options',
      'Move the options to http2',
      'Leave http2 out to serve HTTP/1.1',
    )
  }

  if (h2?.allowHTTP1 === true && https === undefined) {
    throw configurationError(
      'Cannot set http2.allowHTTP1 without https: only an HTTP/2 server over TLS falls back to HTTP/1.1',
      'Add the https section with the key and certificate',
      'Leave allowHTTP1 out',
    )
  }

  const tls = https as HTTPSServerOptions | undefined
  const h1: HTTPServerOptions = { keepAliveTimeout: IDLE_TIMEOUT, ...(http as HTTPServerOptions | undefined) }

  return {
    engine,
    listen: listen as ListenOptions | undefined,
    createServer: listener => {
      // Each factory types its listener on its own classes; `listener` reads only `res` and `res.req`.
      if (h2 !== undefined) {
        const handler = listener as unknown as HTTP2Listener
        const server =
          tls === undefined ? createHTTP2Server(h2, handler) : createHTTP2SecureServer({ ...tls, ...h2 }, handler)
        server.on('session', (session: ServerHttp2Session) => session.setTimeout(IDLE_TIMEOUT, () => session.close()))
        return server
      }

      const handler = listener as unknown as RequestListener
      return tls === undefined ? createHTTPServer(h1, handler) : createHTTPSServer({ ...h1, ...tls }, handler)
    },
  }
}

type HTTP2Section = HTTP2ServerOptions & { allowHTTP1?: boolean }

type HTTP2Listener = (request: Http2ServerRequest, response: Http2ServerResponse) => void

function isOptions(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
