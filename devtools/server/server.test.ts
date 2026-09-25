import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'

import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

import { DevtoolsModule } from '../module.js'
import { DevtoolsServer } from './server.js'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

// `start()` returns before the server listens.
async function listening(port: number): Promise<void> {
  await vi.waitFor(() => fetch(`http://127.0.0.1:${port}/`))
}

describe('DevtoolsServer', () => {
  // An application's close() disposes its container. A devtools server left running keeps the process alive after
  // the shutdown has finished, and an open devtools tab would keep the server itself from closing.
  it('stops with its container, disconnecting the tabs still open', async () => {
    const port = await freePort()
    const container = new CaffeineIoC({ decorators: false, modules: [DevtoolsModule({ port })] })
    await container.init()
    container.get(DevtoolsServer).start()
    await listening(port)

    const tab = new WebSocket(`ws://127.0.0.1:${port}`)
    // Every new connection is sent a snapshot first, so its arrival means the tab is connected.
    await once(tab, 'message')
    const disconnected = once(tab, 'close')

    await container.dispose()

    await disconnected
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  // Code that stops the server itself still has the container stop it again on dispose.
  it('resolves a stop that finds nothing left to stop', async () => {
    const port = await freePort()
    const server = new DevtoolsServer({ port }).start()
    await listening(port)

    await server.stop()

    await expect(server.stop()).resolves.toBeUndefined()
  })
})
