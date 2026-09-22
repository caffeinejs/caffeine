import { connect, createServer, type AddressInfo, type Socket } from 'node:net'

/** A TCP relay in front of a server, with the outages a spec wants to stage. */
export interface TCPProxy {
  /** The port on `127.0.0.1` a client dials instead of the server's. */
  readonly port: number
  /** Stops passing replies on: requests still reach the server, nothing comes back. A paused server looks like this. */
  hold(): void
  /** Passes replies on again, the ones held back first. */
  release(): void
  /** Closes every connection, the server side included. A restart looks like this; a client reconnects through the proxy. */
  dropConnections(): void
  /** Turns new connections away at once, as a server that is down does. With `dropConnections`, an outage. */
  refuse(): void
  /** Takes new connections again. */
  accept(): void
  close(): Promise<void>
}

interface Relay {
  readonly client: Socket
  readonly upstream: Socket
  held: (string | Buffer)[]
}

/**
 * Starts a relay to `upstream` on a free loopback port. Byte-for-byte, no protocol awareness, so it sits in
 * front of Redis or Valkey as it would in front of anything else.
 */
export async function startProxy(upstream: { host: string; port: number }): Promise<TCPProxy> {
  const relays = new Set<Relay>()
  let holding = false
  let refusing = false

  const server = createServer(client => {
    if (refusing) {
      client.destroy()
      return
    }

    const relay: Relay = { client, upstream: connect(upstream), held: [] }
    relays.add(relay)

    const end = () => {
      relays.delete(relay)
      relay.client.destroy()
      relay.upstream.destroy()
    }

    relay.client.on('data', chunk => relay.upstream.write(chunk))
    relay.upstream.on('data', chunk => {
      if (holding) {
        relay.held.push(chunk)
      } else {
        relay.client.write(chunk)
      }
    })
    relay.client.on('close', end)
    relay.upstream.on('close', end)
    relay.client.on('error', end)
    relay.upstream.on('error', end)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const dropConnections = () => {
    for (const relay of [...relays]) {
      relay.client.destroy()
      relay.upstream.destroy()
    }
    relays.clear()
  }

  return {
    port: (server.address() as AddressInfo).port,
    hold() {
      holding = true
    },
    release() {
      holding = false
      for (const relay of relays) {
        for (const chunk of relay.held.splice(0)) {
          relay.client.write(chunk)
        }
      }
    },
    dropConnections,
    refuse() {
      refusing = true
    },
    accept() {
      refusing = false
    },
    async close() {
      dropConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
