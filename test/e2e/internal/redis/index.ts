import { connect } from 'node:net'

export function redisEndpoint(url: URL): { host: string; port: number } {
  const { hostname, port } = url
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return { host, port: Number(port || 6379) }
}

export function reachable(url: string): Promise<boolean> {
  const endpoint = redisEndpoint(new URL(url))

  return new Promise(resolve => {
    const socket = connect({ ...endpoint, timeout: 2000 })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }

    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
