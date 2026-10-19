import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { ErrBrewPathValue, brewer } from '../index.js'

/**
 * Whatever a caller puts in a path or a query reaches the handler exactly as it was given.
 *
 * Asserted through a real server, not against the client's own encoding: the property is the round trip. The
 * characters are the ones that mean something in a URL, plus a two-byte and a four-byte one.
 */

const char = fc.constantFrom(...'aZ09/?#%&=+:@;, -_.~ø😀'.match(/./gu)!)
const text = fc.string({ unit: char, minLength: 1, maxLength: 6 })

// A value a URL would resolve as a step along the path is refused by design, so it is generated separately.
const isStep = (part: string) => part === '.' || part === '..'

const echo = new Router('/echo')
  .get('/param/:value')
  .handler(ctx => ({ value: ctx.req.param('value') }))
  .get('/files/*')
  .handler(ctx => ({ rest: ctx.req.param()['*'] }))
  .get('/search')
  .handler(ctx => ({ url: ctx.req.url }))

const app = createWebApplication().mount(echo)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

describe('brewer (property)', () => {
  it.prop([text.filter(value => !isStep(value))])('sends a path parameter that arrives as given', async value => {
    const client = brewer(app)

    expect(await (await client.echo.param({ value }).get()).json()).toEqual({ value })
  })

  it.prop([
    fc.array(
      text.filter(part => !part.includes('/') && !isStep(part)),
      { minLength: 1, maxLength: 4 },
    ),
  ])('sends a wildcard that arrives as given, slashes and all', async parts => {
    const client = brewer(app)
    const rest = parts.join('/')

    expect(await (await client.echo.files({ '*': rest }).get()).json()).toEqual({ rest })
  })

  it.prop([fc.dictionary(text, fc.oneof(text, fc.array(text, { minLength: 1, maxLength: 3 })), { maxKeys: 4 })])(
    'sends a query whose every value arrives as given, a list as repeated keys in order',
    async query => {
      const client = brewer(app)

      const { url } = await (await client.echo.search.get({ query })).json()
      const received = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')

      expect(new Set(received.keys())).toEqual(new Set(Object.keys(query)))
      for (const [key, value] of Object.entries(query)) {
        expect(received.getAll(key)).toEqual(Array.isArray(value) ? value : [value])
      }
    },
  )

  it.prop([fc.array(fc.constantFrom('.', '..', 'a', '...', '.a'), { minLength: 1, maxLength: 4 })])(
    'refuses a wildcard exactly when one of its parts would be read as a step along the path',
    async parts => {
      const client = brewer(app)
      const rest = parts.join('/')
      const sent = client.echo.files({ '*': rest }).get()

      if (parts.some(isStep)) {
        await expect(sent).rejects.toBeInstanceOf(ErrBrewPathValue)
      } else {
        expect(await (await sent).json()).toEqual({ rest })
      }
    },
  )
})
