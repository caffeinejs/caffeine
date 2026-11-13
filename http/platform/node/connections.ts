import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import type { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import type { Http2SecureServer, Http2Server, ServerHttp2Session } from 'node:http2'
import type { Server as HTTPSServer } from 'node:https'
import type { Server as NetServer, Socket } from 'node:net'
import { Server as TLSServer, type TLSSocket } from 'node:tls'

import type { ServerAddress } from '../../adapter.js'

/** Every server the Node application builds: what `app.instance` is. */
export type NodeHTTPServer = Server | HTTPSServer | Http2Server | Http2SecureServer

/**
 * What a server has open, kept so that it can be ended. A set whose event the server never emits stays empty.
 */
export interface OpenConnections {
  /** Every TCP connection: what {@link destroyConnections} cuts, and {@link closeServer} ends when silent. */
  readonly sockets: Set<Socket>
  /** Every TLS connection, the socket requests arrive on: what {@link closeServer} ends when silent. */
  readonly secured: Set<TLSSocket>
  /** Every HTTP/2 session: what {@link closeServer} closes. */
  readonly sessions: Set<ServerHttp2Session>
}

/** Node's diagnostics channel for an HTTP/1 response that has finished, on any server: `{ server, socket, … }`. */
const RESPONSE_FINISH = 'http.server.response.finish'

/**
 * Starts keeping what `server` has open.
 *
 * Node's `close()` waits on what it does not end itself. An HTTP/1 server ends its idle connections once. Node 24
 * counts one that has not sent a request as active, never idle, so a client that connects and stays silent (a
 * browser's preconnect, a load balancer's TCP check) holds it; Node 26 resets it. A TLS server's HTTP layer meets a
 * connection only once its handshake ends, so not even `closeAllConnections()` reaches one still handshaking. Node
 * 22's HTTP/2 server leaves its sessions open, an idle one until its session timeout.
 */
export function trackConnections(server: NetServer): OpenConnections {
  const open: OpenConnections = { sockets: new Set(), secured: new Set(), sessions: new Set() }
  keepOpen(server, 'connection', open.sockets)
  keepOpen(server, 'secureConnection', open.secured)
  keepOpen(server, 'session', open.sessions)
  return open
}

/**
 * Closes `server` gracefully: ends what is silent, closes HTTP/2 sessions, ends HTTP/1 connections left idle as each
 * response finishes, then awaits `close`, which stops the server.
 */
export async function closeServer(server: NetServer, open: OpenConnections, close: () => Promise<void>): Promise<void> {
  const { sockets, secured, sessions } = open

  // A connection that has not sent a byte carries no request, partial request or upgrade: a TCP connection that
  // never began its handshake, or a TLS one that finished it and fell silent, an HTTP/2 one that never sent its
  // preface included. Each is destroyed, whether open when closing began or opening after, before the server stops
  // listening or from a handshake that ends after. Judged once Node has read what had arrived, so a request already
  // on its way is answered.
  const endIfSilent = (socket: Socket) =>
    afterIO(() => {
      if (socket.bytesRead === 0) {
        socket.destroy()
      }
    })
  server.on('connection', endIfSilent)
  server.on('secureConnection', endIfSilent)
  for (const socket of [...sockets, ...secured]) {
    endIfSilent(socket)
  }

  // An HTTP/2 session, open or opening, is closed: `session.close()` refuses new streams and ends the session once
  // those still open have. It does not end one that never read a preface, which the rule above sees to.
  server.on('session', (session: ServerHttp2Session) => session.close())
  for (const session of sessions) {
    session.close()
  }

  // A request in flight that finishes after Node's one pass over the idle HTTP/1 connections leaves its own idle
  // and kept alive for the client, so the idle ones are ended again as each response finishes. Subscribed only
  // while closing: the channel reports every server's HTTP/1 responses, `allowHTTP1` ones included. A server with
  // no idle connections to end, an HTTP/2 one, is skipped.
  const closeIdle = (message: unknown) => {
    if ((message as { server: unknown }).server === server) {
      setImmediate(() => (server as Partial<Pick<Server, 'closeIdleConnections'>>).closeIdleConnections?.())
    }
  }

  subscribe(RESPONSE_FINISH, closeIdle)
  try {
    // Node 26's `close()` resets a connection that has not delivered a request yet, bytes already arrived included:
    // the server reads them first, and the silent connections above are judged by then.
    await new Promise<void>(resolve => afterIO(resolve))
    await close()
  } finally {
    unsubscribe(RESPONSE_FINISH, closeIdle)
  }
}

/**
 * Cuts every connection a close is still waiting on: a request or an HTTP/2 stream in flight, a keep-alive
 * connection not yet expired, a TLS handshake that never finished. For when the shutdown budget is spent.
 */
export function destroyConnections(open: OpenConnections): void {
  for (const socket of open.sockets) {
    socket.destroy()
  }
}

/** Where `server` is listening, or `undefined` while it is not. */
export function serverAddress(server: NetServer): ServerAddress | undefined {
  const bound = server.address()

  // `null` when nothing is listening.
  if (bound == null) {
    return undefined
  }

  // A string when bound to a unix socket or a named pipe, which has a path and no host, port or origin.
  if (typeof bound === 'string') {
    return { host: '', port: 0, path: bound, origin: '' }
  }

  // Both HTTPS and HTTP/2 over TLS servers are TLS servers.
  const scheme = server instanceof TLSServer ? 'https' : 'http'

  return { host: bound.address, port: bound.port, path: '', origin: originOf(scheme, bound.address, bound.port) }
}

/** Keeps in `open` what `server` hands over on `event`, until it closes. */
function keepOpen<T extends EventEmitter>(server: NetServer, event: string, open: Set<T>): void {
  server.on(event, (item: T) => {
    open.add(item)
    item.once('close', () => open.delete(item))
  })
}

/**
 * Calls `fn` once Node has polled for I/O at least once more, so that what a socket had received when this was called
 * has been read. Node polls between two runs of its `setImmediate` callbacks.
 */
function afterIO(fn: () => void): void {
  setImmediate(() => setImmediate(fn))
}

/**
 * `0.0.0.0` and `::` are addresses to accept connections on, not addresses to dial, so an origin built from
 * them is not reliably reachable. Both map to their loopback equivalent; IPv6 is bracketed.
 */
function originOf(scheme: 'http' | 'https', host: string, port: number): string {
  if (host === '0.0.0.0') {
    return `${scheme}://127.0.0.1:${port}`
  }

  if (host === '::' || host === '::1') {
    return `${scheme}://[::1]:${port}`
  }

  return host.includes(':') ? `${scheme}://[${host}]:${port}` : `${scheme}://${host}:${port}`
}
