import { createServer } from 'node:http'

import { benchBody, port } from './config.js'

const payload = Buffer.from(JSON.stringify(benchBody))

const srv = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(payload)
})
// Node's 5s default races pooled clients (e.g. fetchy-undici's Pool) reusing a keep-alive
// socket right as the server closes it, stalling that request for ~5s. Raise it well above
// any client-side keep-alive timeout, matching standard Node production server guidance.
srv.keepAliveTimeout = 30000
srv
  .listen(port)
  .on('listening', () => {
    console.error(`Benchmark server listening on http://localhost:${port}`)
  })
  .on('error', console.error)
