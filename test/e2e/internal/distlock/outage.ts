import { createClient } from '@redis/client'

import { startProxy, type TCPProxy } from '../tcp_proxy.js'

/** A Redis or Valkey client that reaches its server through a relay a spec can stage outages on. */
export interface RelayedClient {
  readonly proxy: TCPProxy
  readonly client: ReturnType<typeof newClient>
  close(): Promise<void>
}

function newClient(port: number) {
  return createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: () => 50 } })
}

function ignore(): void {
  return undefined
}

/**
 * Connects a client to the server at `url` through a TCP relay. The client reconnects every 50 ms, and listens on
 * its error channel: a dropped connection is what these specs are about, and an unlistened error event throws.
 */
export async function relayedClient(url: string): Promise<RelayedClient> {
  const { hostname, port } = new URL(url)
  const proxy = await startProxy({ host: hostname, port: Number(port) })
  const client = newClient(proxy.port)
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
