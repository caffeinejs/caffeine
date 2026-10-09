import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  readonly baseURL: string
  stop(): Promise<void>
}

/**
 * Minimal local `node:http` server: echoes method/url/headers/body back as JSON. Request headers
 * steer the answer:
 *
 * - `x-test-status` sets the response status, and `x-test-reason` its reason phrase;
 * - `x-test-body-bytes` answers with that many bytes instead, for a body larger than the socket
 *   buffers;
 * - `x-test-header-bytes` adds a response header of that many bytes;
 * - `x-test-echo: raw` answers with the request's bytes untouched, under its content-type, and
 *   reports its `content-length` and `transfer-encoding` in `x-test-content-length` and
 *   `x-test-transfer-encoding`. The JSON echo reads the body as UTF-8, which binary bytes do not
 *   survive.
 */
export function startTestServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []

      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const status = Number(req.headers['x-test-status'] ?? 200)
        const reason = req.headers['x-test-reason'] as string | undefined
        const bodyBytes = req.headers['x-test-body-bytes']
        const headerBytes = req.headers['x-test-header-bytes']
        const extra: Record<string, string> =
          headerBytes === undefined ? {} : { 'x-test-large': 'x'.repeat(Number(headerBytes)) }

        if (bodyBytes !== undefined) {
          res.writeHead(status, reason, { ...extra, 'content-type': 'application/octet-stream' })
          res.end(Buffer.alloc(Number(bodyBytes), 'x'))
          return
        }

        if (req.headers['x-test-echo'] === 'raw') {
          res.writeHead(status, reason, {
            'content-type': req.headers['content-type'] ?? 'application/octet-stream',
            'x-test-content-length': req.headers['content-length'] ?? '',
            'x-test-transfer-encoding': req.headers['transfer-encoding'] ?? '',
          })
          res.end(Buffer.concat(chunks))
          return
        }

        const body = Buffer.concat(chunks).toString('utf-8')

        res.writeHead(status, reason, { ...extra, 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo

      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise((res, rej) => {
            server.closeAllConnections()
            server.close(err => (err ? rej(err) : res()))
          }),
      })
    })
  })
}
