import { connect } from 'node:net'

export function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url)

  return new Promise(resolve => {
    const socket = connect({ host: hostname, port: Number(port || 6379), timeout: 2000 })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }

    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
