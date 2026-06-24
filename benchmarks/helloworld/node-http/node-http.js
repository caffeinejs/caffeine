import { createServer } from 'node:http'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const BODY = JSON.stringify({ hello: 'world' })

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(BODY)
}).listen(PORT, '0.0.0.0')
