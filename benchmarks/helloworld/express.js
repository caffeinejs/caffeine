import express from 'express'

const PORT = parseInt(process.env.PORT ?? '3000', 10)

const app = express()
app.disable('x-powered-by')
app.disable('etag')

app.get('/', (_req, res) => res.json({ hello: 'world' }))

app.listen(PORT, '0.0.0.0')
