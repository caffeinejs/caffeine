import { connect } from 'node:net'

export function reachable(url: string, defaultPort = 6379): Promise<boolean> {
  const { hostname, port } = new URL(url)

  return new Promise(resolve => {
    const socket = connect({ host: hostname, port: Number(port || defaultPort), timeout: 2000 })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }

    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
