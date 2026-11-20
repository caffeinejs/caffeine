import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

const fixtures = new URL('./fixtures/http-wait-until/', import.meta.url)
const workerd = (createRequire(import.meta.url)('workerd') as { default: string }).default

it(
  'registers work with workerd once and completes it after the client reads the response',
  { timeout: 30_000 },
  async ({ onTestFinished, signal }) => {
    const project = await mkdtemp(join(tmpdir(), 'caffeine-http-wait-until-'))
    onTestFinished(() => rm(project, { recursive: true, force: true }))
    await copyFile(new URL('worker.capnp', fixtures), join(project, 'worker.capnp'))
    await build({
      entryPoints: [fileURLToPath(new URL('worker.mjs', fixtures))],
      outfile: join(project, 'bundle.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      conditions: ['node'],
      // CommonJS dependencies in the ESM bundle require Node built-ins from the runtime.
      banner: {
        js: 'import { createRequire as createWorkerRequire } from "node:module"; const require = createWorkerRequire(import.meta.url);',
      },
      logLevel: 'silent',
    })

    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<string>()
    const completed = Promise.withResolvers<string>()
    const latch = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/wait') {
        started.resolve()
        void release.promise.then(id => res.end(id))
      } else if (req.method === 'POST' && req.url?.startsWith('/complete/')) {
        completed.resolve(req.url.slice('/complete/'.length))
        res.writeHead(204).end()
      } else {
        res.writeHead(404).end()
      }
    })
    latch.listen(0, '127.0.0.1')
    await once(latch, 'listening')
    onTestFinished(async () => {
      release.resolve('')
      latch.closeAllConnections()
      await latch[Symbol.asyncDispose]()
    })
    const { port } = latch.address() as AddressInfo

    const worker = spawn(
      workerd,
      ['serve', 'worker.capnp', '--control-fd=1', '--external-addr=latch=127.0.0.1:' + port],
      {
        cwd: project,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const closed = once(worker, 'close')
    onTestFinished(async () => {
      worker.kill('SIGKILL')
      await closed.catch(() => undefined)
    })

    let output = ''
    worker.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
    })
    const control = createInterface({ input: worker.stdout })
    const listening = once(control, 'line', { signal })
    const exited = closed.then(([code, reason]) => {
      throw new Error(`workerd exited (${code ?? reason}): ${output}`)
    })

    async function checkHandoff() {
      const [line] = await listening
      const endpoint = JSON.parse(line) as { port: number }
      const base = 'http://127.0.0.1:' + endpoint.port
      const ready = await fetch(base + '/ready', { signal })
      expect(ready.status, output).toBe(200)
      expect(await ready.text(), output).toBe('ready')

      const unsupported = await fetch(base + '/work', { headers: { 'x-unsupported': '1' }, signal })
      expect(unsupported.status, output).toBe(200)
      expect(await unsupported.text(), output).toBe('unsupported')

      const response = await fetch(base + '/work', { signal })
      expect(response.status, output).toBe(200)
      expect(await response.json()).toEqual({ registrations: 1 })
      await started.promise

      const id = randomUUID()
      release.resolve(id)
      expect(await completed.promise).toBe(id)
    }

    await Promise.race([checkHandoff(), exited])
  },
)
