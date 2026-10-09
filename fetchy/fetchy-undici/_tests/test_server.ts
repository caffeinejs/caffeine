import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  readonly baseURL: string
  stop(): Promise<void>
}

/**
 * Minimal local `node:http` server: echoes method/url/headers/body back as JSON, honoring a
 * `x-test-status` request header to control the response status for error-path tests, and a
 * `x-test-body-bytes` request header that answers with that many bytes instead, for a body larger
 * than the socket buffers.
 */
export function startTestServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []

      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const status = Number(req.headers['x-test-status'] ?? 200)
        const bodyBytes = req.headers['x-test-body-bytes']

        if (bodyBytes !== undefined) {
          res.writeHead(status, { 'content-type': 'application/octet-stream' })
          res.end(Buffer.alloc(Number(bodyBytes), 'x'))
          return
        }

        const body = Buffer.concat(chunks).toString('utf-8')

        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo

      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        stop: () => new Promise((res, rej) => server.close(err => (err ? rej(err) : res()))),
      })
    })
  })
}
