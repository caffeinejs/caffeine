import { Router } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { fc, it } from '@fast-check/vitest'
import { afterAll, beforeAll, describe, expect } from 'vitest'

import { ErrBrewPathParam, ErrBrewPathValue, brewer } from '../index.js'

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

// A value that shares its segment holds none of the separators: one that did would be ambiguous by the route's own
// design, whatever the client sent.
const piece = fc.string({ unit: char.filter(c => !'-./'.includes(c)), minLength: 1, maxLength: 6 })
const twoDigits = fc.integer({ min: 0, max: 99 }).map(n => String(n).padStart(2, '0'))

const echo = new Router('/echo')
  .get('/param/:value')
  .handler(ctx => ({ value: ctx.req.param('value') }))
  .get('/files/*')
  .handler(ctx => ({ rest: ctx.req.param()['*'] }))
  .get('/search')
  .handler(ctx => ({ url: ctx.req.url }))
  .get('/near/:lat-:lng')
  .handler(ctx => ctx.req.param())
  .get('/doc/:name.:ext')
  .handler(ctx => ctx.req.param())
  .get('/span/:from-:to-:step')
  .handler(ctx => ctx.req.param())
  .get('/mixed/:a-:b.:c')
  .handler(ctx => ctx.req.param())
  .get('/report/:name.json')
  .handler(ctx => ctx.req.param())
  .get('/api/v:version')
  .handler(ctx => ctx.req.param())
  .get('/item/item-:id.json')
  .handler(ctx => ctx.req.param())
  .get('/radius/:lat-:lng/r/:r')
  .handler(ctx => ctx.req.param())
  .get('/at/:hour(^\\d{2})h:minute(^\\d{2})m')
  .handler(ctx => ctx.req.param())
  .get('/opt/:lat-:lng?')
  .handler(ctx => ctx.req.param())
  .get('/dots/:a.:b')
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

  it.prop([text.filter(value => !isStep(value))])(
    'builds the same path for a lone parameter through the proxy and through $request',
    async value => {
      const sent: string[] = []
      const client = brewer(app, {
        fetch: (input, init) => {
          sent.push(String(input))
          return app.request(input as string, init)
        },
      })

      await client.echo.param({ value }).get()
      await client.$request('GET', '/echo/param/:value', { params: { value } })

      expect(sent[1]).toBe(sent[0])
    },
  )

  it.prop([piece, piece, piece])(
    'sends parameters that share a segment, each arriving as given under its own name',
    async (a, b, c) => {
      const client = brewer(app)

      const near = await client.$request('GET', '/echo/near/:lat-:lng', { params: { lat: a, lng: b } })
      const doc = await client.$request('GET', '/echo/doc/:name.:ext', { params: { name: a, ext: b } })
      const span = await client.$request('GET', '/echo/span/:from-:to-:step', { params: { from: a, to: b, step: c } })
      const mixed = await client.$request('GET', '/echo/mixed/:a-:b.:c', { params: { a, b, c } })

      expect(await near.json()).toEqual({ lat: a, lng: b })
      expect(await doc.json()).toEqual({ name: a, ext: b })
      expect(await span.json()).toEqual({ from: a, to: b, step: c })
      expect(await mixed.json()).toEqual({ a, b, c })
    },
  )

  it.prop([piece, piece])('sends a parameter beside text of its own, and the segments after it', async (a, b) => {
    const client = brewer(app)

    const report = await client.$request('GET', '/echo/report/:name.json', { params: { name: a } })
    const api = await client.$request('GET', '/echo/api/v:version', { params: { version: a } })
    const item = await client.$request('GET', '/echo/item/item-:id.json', { params: { id: a } })
    const radius = await client.$request('GET', '/echo/radius/:lat-:lng/r/:r', { params: { lat: a, lng: b, r: a } })

    expect(await report.json()).toEqual({ name: a })
    expect(await api.json()).toEqual({ version: a })
    expect(await item.json()).toEqual({ id: a })
    expect(await radius.json()).toEqual({ lat: a, lng: b, r: a })
  })

  it.prop([twoDigits, twoDigits])('keeps the text between constrained parameters', async (hour, minute) => {
    const client = brewer(app)

    const res = await client.$request('GET', '/echo/at/:hour(^\\d{2})h:minute(^\\d{2})m', { params: { hour, minute } })

    expect(await res.json()).toEqual({ hour, minute })
  })

  it.prop([fc.record({ lat: piece, lng: piece }, { requiredKeys: [] })])(
    'drops an optional shared segment given no value, fills it given every value, and refuses it given some',
    async params => {
      const client = brewer(app)
      // The types take every value or none, so a subset goes through a cast, as an unchecked call would send it.
      const sent = client.$request('GET', '/echo/opt/:lat-:lng?', { params: params as never })
      const given = Object.keys(params).length

      if (given === 1) {
        await expect(sent).rejects.toBeInstanceOf(ErrBrewPathParam)
      } else {
        expect(await (await sent).json()).toEqual(params)
      }
    },
  )

  it.prop([fc.constantFrom('', '.', '..', 'a', '.a', '...'), fc.constantFrom('', '.', '..', 'a', '.a', '...')])(
    'refuses a shared segment exactly when a value, or the segment once filled, would be read as a step',
    async (a, b) => {
      const client = brewer(app)
      const sent = client.$request('GET', '/echo/dots/:a.:b', { params: { a, b } })

      if ([a, b, `${a}.${b}`].some(isStep)) {
        await expect(sent).rejects.toBeInstanceOf(ErrBrewPathValue)
      } else {
        expect(await (await sent).json()).toEqual({ url: `/echo/dots/${a}.${b}` })
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
