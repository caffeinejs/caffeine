import { spawn } from 'node:child_process'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib'

import type { ContentCoding } from './compress.js'

/** Each coding's decoder, independent of the plugin's own codecs. */
export const DECODE: Readonly<Record<ContentCoding, (bytes: Buffer) => Buffer>> = {
  gzip: gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
  zstd: zstdDecompressSync,
}

/** Each coding's encoder, for request bodies a client codes. */
export const ENCODE: Readonly<Record<ContentCoding, (bytes: Uint8Array) => Buffer>> = {
  gzip: gzipSync,
  deflate: deflateSync,
  br: brotliCompressSync,
  zstd: zstdCompressSync,
}

/** `bytes` decoded from the `Content-Encoding` they came with, or as they are without one. */
export function decodeAs(coding: string | null | undefined, bytes: Buffer): Buffer {
  return coding === null || coding === undefined ? bytes : DECODE[coding as ContentCoding](bytes)
}

/** An answer read off the socket, its body as it came: still coded. */
export interface WireReply {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

/**
 * Sends one request to `origin` with `node:http`, which decodes nothing, and reads the whole answer. A body given as
 * several chunks is written one chunk at a time, with no length: chunked.
 */
export function send(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array | readonly Uint8Array[] } = {},
): Promise<WireReply> {
  const url = new URL(path, origin)

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: options.headers,
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)

    const body = options.body
    if (Array.isArray(body)) {
      for (const chunk of body) {
        req.write(chunk)
      }
      req.end()
    } else {
      req.end(body as Uint8Array | undefined)
    }
  })
}

/** A Bun process serving the compression fixture, and how to stop it. */
export interface BunFixture {
  readonly origin: string
  stop(): Promise<void>
}

// Under http/platform/bun/: only http/platform/ may import the Bun adapter.
const BUN_FIXTURE = fileURLToPath(new URL('../../platform/bun/_testdata/compress.ts', import.meta.url))

/**
 * Spawns `bun` on the fixture, which serves the built package with the Bun adapter, `compression()` and
 * `decompression()`, and resolves once it prints where it listens.
 */
export async function startBunFixture(): Promise<BunFixture> {
  const child = spawn('bun', [BUN_FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += String(chunk)))

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited
    }
  }

  const origin = await new Promise<string>((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', chunk => {
      buffered += String(chunk)
      let end: number
      while ((end = buffered.indexOf('\n')) !== -1) {
        const text = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        // The logger's own lines are not JSON: only the fixture's is.
        try {
          resolve((JSON.parse(text) as { origin: string }).origin)
        } catch {
          continue
        }
      }
    })
    child.once('exit', code => reject(new Error(`bun exited with ${code} first: ${stderr}`)))
    child.once('error', err => reject(err))
  }).catch(async (err: unknown) => {
    await stop()
    throw err
  })

  return { origin, stop }
}
