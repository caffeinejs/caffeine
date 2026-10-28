import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createWebApplication, newRouter } from '../../platform/fastify/index.js'
import { ErrHTTPConflict } from './http.js'

function orders() {
  return newRouter('/orders').post('/:id/pay', () => {
    throw new ErrHTTPConflict('Order 42 is already paid')
  })
}

describe('problem negotiation', () => {
  const app = createWebApplication()
    .errorHandling(e => e.serializer('text/html', (_ctx, problem) => `<h1>${problem.title}</h1>`))
    .mount(orders())

  beforeAll(() => app.bootstrap())
  afterAll(() => app.close())

  // Cloudflare's rules for agent error pages: the highest q wins, then an exact type over a wildcard, then the
  // first listed, and a wildcard alone shows no preference, so a client that names nothing gets plain JSON.
  it.each([
    ['', 'application/json'],
    ['*/*', 'application/json'],
    ['application/json', 'application/json'],
    ['application/json; charset=utf-8', 'application/json'],
    ['application/problem+json', 'application/problem+json'],
    ['text/markdown', 'text/markdown'],
    ['text/markdown; charset=utf-8', 'text/markdown'],
    ['TEXT/MARKDOWN', 'text/markdown'],
    ['text/*', 'text/markdown'],
    ['application/*', 'application/json'],
    ['application/json, text/markdown;q=0.9', 'application/json'],
    ['application/json;q=0.5, text/markdown', 'text/markdown'],
    ['text/markdown, application/json', 'text/markdown'],
    ['application/json, text/markdown', 'application/json'],
    ['text/markdown, */*', 'text/markdown'],
    ['text/*, application/json', 'application/json'],
    ['application/problem+json;q=0.5, application/json;q=0.4', 'application/problem+json'],
    ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'text/html'],
    // An error never answers 406: a client that accepts nothing offered still learns what failed.
    ['image/png', 'application/json'],
    ['application/json;q=0', 'application/json'],
  ])('answers Accept "%s" with %s', async (accept, mediaType) => {
    const res = await app.request('/orders/42/pay', {
      method: 'POST',
      headers: accept === '' ? {} : { accept },
    })

    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe(`${mediaType}; charset=utf-8`)
    // One URL, several bodies: a cache keys on Accept or hands Markdown to a JSON client.
    expect(res.headers.get('vary')).toBe('Accept')
  })

  it('sends the same problem in every format', async () => {
    const accept = (value: string) => ({ method: 'POST', headers: { accept: value } })

    const json = (await (await app.request('/orders/42/pay', accept('application/json'))).json()) as object
    const problem = (await (await app.request('/orders/42/pay', accept('application/problem+json'))).json()) as object
    const markdown = await (await app.request('/orders/42/pay', accept('text/markdown'))).text()

    const stable = { type: 'about:blank', title: 'Conflict', status: 409, code: 'ERR_HTTP_CONFLICT' }
    expect(json).toMatchObject({ ...stable, detail: 'Order 42 is already paid' })
    expect(problem).toMatchObject({ ...stable, detail: 'Order 42 is already paid' })
    expect(markdown).toContain('status: 409\ncode: "ERR_HTTP_CONFLICT"\n')
    expect(markdown).toContain('## What happened\n\nOrder 42 is already paid\n')
  })
})
