import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url))

function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = connect(port, 'localhost')

      socket.once('connect', () => {
        socket.end()
        resolve()
      })

      socket.once('error', () => {
        socket.destroy()

        if (Date.now() > deadline) {
          reject(new Error(`Benchmark server did not start listening on port ${port} in time`))
          return
        }

        setTimeout(attempt, 100)
      })
    }

    attempt()
  })
}

/**
 * Spawns `server.ts` as a child process and waits for it to accept connections. Returns a `stop()`
 * function that kills the child — call it once the benchmark run finishes.
 */
export async function spawnServer(port: number): Promise<() => void> {
  const child = spawn('node', ['--import=tsx', serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  await waitForPort(port)

  return () => {
    child.kill()
  }
}
