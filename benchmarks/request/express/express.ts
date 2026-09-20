import { Ajv } from 'ajv'
import express, { type NextFunction, type Request, type Response } from 'express'

const PORT = parseInt(process.env.PORT ?? '3027', 10)
const app = express()

interface Data {
  text: string
  num: number
  bool: boolean
}

const schema = {
  type: 'object',
  required: ['text', 'num', 'bool'],
  properties: {
    text: { type: 'string' },
    num: { type: 'number' },
    bool: { type: 'boolean' },
  },
}

// Coercion writes the typed value back into the validated object, as the Fastify fixture's validation does.
const ajv = new Ajv({ coerceTypes: true })
const validateParams = ajv.compile<Data>(schema)
const validateQuery = ajv.compile<Data>(schema)
const validateBody = ajv.compile<Data>(schema)

app.disable('x-powered-by')
app.disable('etag')
app.use(express.json())

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header('x-request-id', Math.random().toString(36).slice(2))
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post(
  '/api/test/:text/:num/:bool',
  (req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-api-key'] !== 'benchmark') {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  },
  (req: Request, res: Response) => {
    // Read once: Express builds `req.query` on every access, so a second read would lose the coerced values.
    const p: unknown = req.params
    const q: unknown = req.query
    const b: unknown = req.body
    const h = req.headers

    if (!validateParams(p) || !validateQuery(q) || !validateBody(b)) {
      res.status(400).json({ error: 'Bad Request' })
      return
    }

    res.header('text', h.text as string)
    res.header('num', h.num as string)
    res.header('bool', h.bool as string)

    res.json({
      params: { text: p.text, num: p.num, bool: p.bool },
      query: { text: q.text, num: q.num, bool: q.bool },
      body: { text: b.text, num: b.num, bool: b.bool },
    })
  },
)

app.listen(PORT, '0.0.0.0')
