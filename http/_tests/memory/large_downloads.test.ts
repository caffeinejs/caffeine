import { openAsBlob } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Attachment, Router } from '../../index.js'
import { createWebApplication } from '../../platform/fastify/index.js'

/**
 * That a large download is streamed rather than held: the server's memory stays far below the size of what it
 * sends, and a download a client abandons leaves nothing behind once collected.
 *
 * The bound is a quarter of the body. Streaming a gigabyte peaks near 70 MiB of buffers here, the collector running
 * on its own schedule; a server that read the body into memory first peaks above 2 GiB.
 */

const MiB = 1024 * 1024
const SIZE = 1024 * MiB
const BOUND = SIZE / 4
const ABANDONED = 256 * MiB
// Far enough into a download that the server is streaming it; any point before its end tests the release.
const ABANDON_AFTER = 8 * MiB

let dir: string
let path: string
let abandonedPath: string
let sparse = false

async function collect(): Promise<void> {
  globalThis.gc!()
  await new Promise(resolve => setImmediate(resolve))
  globalThis.gc!()
}

/** Reads a download to its end, a chunk at a time, noting the most buffer memory the process held meanwhile. */
async function peakWhileReading(url: string, headers: Record<string, string> = {}) {
  await collect()
  const before = process.memoryUsage().arrayBuffers
  let peak = before
  let received = 0

  // Sampled once a megabyte: reading the process's memory on every chunk would slow the reader being measured.
  let sampleAt = 0
  const res = await fetch(url, { headers })
  for await (const chunk of res.body!) {
    received += chunk.length
    if (received >= sampleAt) {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers)
      sampleAt = received + MiB
    }
  }

  return { status: res.status, received, growth: peak - before }
}

const routes = new Router('/memory')
routes.get('/blob').handler(async () => openAsBlob(path))
routes.get('/attachment').handler(async () => Attachment(await openAsBlob(path), { name: 'disk.img' }))
routes.get('/abandoned').handler(async () => openAsBlob(abandonedPath))

// A client that stops a download part-way can leave the server a connection with no request on it, which its
// graceful close would otherwise wait out (caffeinejs/caffeine#131): every connection is closed as the server closes.
const app = createWebApplication()
  .server(() => ({ factory: { forceCloseConnections: true }, listener: { host: '127.0.0.1', port: 0 } }))
  .mount(routes)

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caffeine-memory-'))
  path = join(dir, 'disk.img')

  abandonedPath = join(dir, 'abandoned.img')

  for (const [file, size] of [
    [path, SIZE],
    [abandonedPath, ABANDONED],
  ] as const) {
    const handle = await open(file, 'w')
    await handle.truncate(size)
    await handle.close()
  }

  const { blocks } = await stat(path)
  sparse = blocks * 512 < 16 * MiB

  await app.run()
})

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

const unsparse = 'this filesystem cannot make a sparse file, and a 1 GiB one would be written out in full'

describe('a large download', () => {
  it('streams a 1 GiB file-backed Blob while holding a fraction of it', async ({ skip }) => {
    skip(!sparse, unsparse)

    const { status, received, growth } = await peakWhileReading(`${app.address!.origin}/memory/blob`)

    expect(status).toBe(200)
    expect(received).toBe(SIZE)
    expect(growth).toBeLessThan(BOUND)
  })

  it('streams a 1 GiB Attachment, asked for as a range, while holding a fraction of it', async ({ skip }) => {
    skip(!sparse, unsparse)

    const { status, received, growth } = await peakWhileReading(`${app.address!.origin}/memory/attachment`, {
      range: 'bytes=0-',
    })

    expect(status).toBe(206)
    expect(received).toBe(SIZE)
    expect(growth).toBeLessThan(BOUND)
  })

  // A part is a slice of the Blob, read from disk as it is sent: a copy of 512 MiB would show as growth past the bound.
  it('streams several ranges adding up to 512 MiB of a 1 GiB Attachment while holding a fraction of them', async ({
    skip,
  }) => {
    skip(!sparse, unsparse)

    const { status, received, growth } = await peakWhileReading(`${app.address!.origin}/memory/attachment`, {
      range: `bytes=0-${256 * MiB - 1},${512 * MiB}-${768 * MiB - 1}`,
    })

    expect(status).toBe(206)
    expect(received).toBeGreaterThan(512 * MiB)
    expect(received).toBeLessThan(512 * MiB + 1024)
    expect(growth).toBeLessThan(BOUND)
  })

  it('leaves nothing held after 20 downloads abandoned part-way', async ({ skip }) => {
    skip(!sparse, unsparse)

    await collect()
    const before = process.memoryUsage().arrayBuffers

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const controller = new AbortController()
        const res = await fetch(`${app.address!.origin}/memory/abandoned`, { signal: controller.signal })
        const reader = res.body!.getReader()
        for (let received = 0; received < ABANDON_AFTER;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          received += value.length
        }
        controller.abort()
        await reader.cancel().catch(() => undefined)
      }),
    )

    // The server answers a new request once it has let the abandoned ones go.
    expect((await fetch(`${app.address!.origin}/memory/blob`, { method: 'HEAD' })).status).toBe(200)

    await collect()
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * MiB)
  })
})
