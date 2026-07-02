import { node } from '@elysiajs/node'
import { Elysia, t } from 'elysia'

const PORT = parseInt(process.env.PORT ?? '3024', 10)

new Elysia({ adapter: node() })
  .onRequest(({ set }) => {
    set.headers['x-request-id'] = Math.random().toString(36)
      .slice(2)
  })
  .get('/health', () => ({ ok: true }))
  .post(
    '/api/test/:text/:num/:bool',
    ({ params, query, body, request, set }) => {
      const hText = request.headers.get('text') ?? ''
      const hNum = request.headers.get('num') ?? ''
      const hBool = request.headers.get('bool') ?? ''

      set.headers['text'] = hText
      set.headers['num'] = hNum
      set.headers['bool'] = hBool

      return {
        params: { text: params.text, num: params.num, bool: params.bool },
        query: { text: query.text, num: query.num, bool: query.bool },
        body: { text: body.text, num: body.num, bool: body.bool },
      }
    },
    {
      beforeHandle({ request, set }) {
        if (request.headers.get('x-api-key') === 'benchmark') {
          return
        }
        set.status = 401
        return { error: 'Unauthorized' }
      },
      params: t.Object({ text: t.String(), num: t.Numeric(), bool: t.BooleanString() }),
      query: t.Object({ text: t.String(), num: t.Numeric(), bool: t.BooleanString() }),
      body: t.Object({ text: t.String(), num: t.Number(), bool: t.Boolean() }),
    },
  )
  .listen({ port: PORT, hostname: '0.0.0.0' })
