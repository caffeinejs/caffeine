import { connect } from 'node:net'

export function redisEndpoint(url: URL, defaultPort = 6379): { host: string; port: number } {
  const { hostname, port } = url
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return { host, port: Number(port || defaultPort) }
}

export function reachable(url: string, defaultPort = 6379): Promise<boolean> {
  const endpoint = redisEndpoint(new URL(url), defaultPort)

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
