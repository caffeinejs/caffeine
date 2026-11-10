import { createClient } from '@redis/client'

import { startProxy, type TCPProxy } from '../tcp_proxy.js'

/** A Redis or Valkey client that reaches its server through a relay a spec can stage outages on. */
export interface RelayedClient {
  readonly proxy: TCPProxy
  readonly client: ReturnType<typeof newClient>
  close(): Promise<void>
}

function newClient(url: string) {
  return createClient({ url, socket: { reconnectStrategy: () => 50 } })
}

/** The server a Redis URL names, with the Redis port when it names none. */
export function upstreamOf(url: string): { host: string; port: number } {
  const { hostname, port } = new URL(url)
  return { host: hostname, port: Number(port || 6379) }
}

/** `url` pointed at a relay on loopback, with its database, credentials and options kept. */
export function relayURL(url: string, port: number): string {
  const relayed = new URL(url)
  relayed.hostname = '127.0.0.1'
  relayed.port = String(port)
  return relayed.toString()
}

function ignore(): void {
  return undefined
}

/**
 * Connects a client to the server at `url` through a TCP relay. The client reconnects every 50 ms, and listens on
 * its error channel: a dropped connection is what these specs are about, and an unlistened error event throws.
 */
export async function relayedClient(url: string): Promise<RelayedClient> {
  const proxy = await startProxy(upstreamOf(url))
  const client = newClient(relayURL(url, proxy.port))
  client.on('error', ignore)
  await client.connect()

  return {
    proxy,
    client,
    async close() {
      proxy.release()
      proxy.accept()
      client.destroy()
      await proxy.close()
    },
  }
}
