import express, { type NextFunction, type Request, type Response } from 'express'

const PORT = parseInt(process.env.PORT ?? '3027', 10)
const app = express()

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
    const p = req.params as { text: string; num: string; bool: string }
    const q = req.query as { text: string; num: string; bool: string }
    const h = req.headers
    const b = (req.body ?? {}) as { text: string; num: number; bool: boolean }

    res.header('text', h.text as string)
    res.header('num', h.num as string)
    res.header('bool', h.bool as string)

    res.json({
      params: { text: p.text, num: Number(p.num), bool: p.bool === 'true' },
      query: { text: q.text, num: Number(q.num), bool: q.bool === 'true' },
      body: { text: b.text, num: b.num, bool: b.bool },
    })
  },
)

app.listen(PORT, '0.0.0.0')
