import { CaffeineIoC } from '@caffeinejs/di'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { Args, Controller, Get, Post } from '../../decorators/index.js'
import { $p } from '../routing/picker.js'
import { portOf } from './parameters.js'

@Controller('/picks')
class Picks {
  @Get('/:id')
  @Args([$p.param('id'), $p.query('q'), $p.header('x-h'), $p.method(), $p.url(), $p.path(), $p.context()])
  all(id: string, q: unknown, h: string, method: string, url: string, path: string, ctx: IContext): object {
    return { id, q, h, method, url, path, isContext: ctx.req.url === url }
  }

  @Get('/port/host')
  @Args([$p.port()])
  port(port: number | null): object {
    return { port }
  }

  @Get('/address/in')
  @Args([$p.address()])
  address(address: string | undefined): object {
    return { address: address ?? null }
  }

  @Get('/user/none')
  @Args([$p.user()])
  user(user: unknown): object {
    return { user }
  }

  @Post('/body/json')
  @Args([$p.body()])
  body(body: unknown): object {
    return { body }
  }

  @Get('/custom/url')
  @Args([$p.pick((req: { httpContext: IContext }) => req.httpContext.req.url)])
  custom(url: string): object {
    return { url }
  }
}
void Picks

const app = createWebApplication({ container: new CaffeineIoC() })

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

describe('engine pickers', () => {
  it('picks params, query, a header, method, url, path and the context', async () => {
    const res = await app.fetch(new Request('http://localhost/picks/7?q=a', { headers: { 'x-h': 'v' } }))

    expect(await res.json()).toEqual({
      id: '7',
      q: 'a',
      h: 'v',
      method: 'GET',
      url: '/picks/7?q=a',
      path: '/picks/7',
      isContext: true,
    })
  })

  it('picks a repeated query key as a list', async () => {
    const res = await app.fetch(new Request('http://localhost/picks/7?q=a&q=b'))

    expect(((await res.json()) as { q: unknown }).q).toEqual(['a', 'b'])
  })

  it.each([
    ['x:8080', 8080],
    ['[::1]:9', 9],
    ['x', null],
  ])('picks the port the Host header %s names', async (host, port) => {
    const res = await app.fetch(new Request('http://localhost/picks/port/host', { headers: { host } }))

    expect(await res.json()).toEqual({ port })
  })

  it('picks 127.0.0.1 as the address of an in-process request', async () => {
    expect(await (await app.request('/picks/address/in')).json()).toEqual({ address: '127.0.0.1' })
  })

  it('picks a user of null before authentication', async () => {
    expect(await (await app.request('/picks/user/none')).json()).toEqual({ user: null })
  })

  it('hands a custom pick the context, reachable as req.httpContext too', async () => {
    expect(await (await app.request('/picks/custom/url')).json()).toEqual({ url: '/picks/custom/url' })
  })
})

describe('portOf', () => {
  it.each([
    ['example.com:3000', 3000],
    ['[::1]:8080', 8080],
    ['[::1]', null],
    ['example.com', null],
    ['example.com:', null],
  ])('reads %s as %s', (host, port) => {
    expect(portOf(host)).toBe(port)
  })
})

describe('the body pick', () => {
  it('hands the handler the parsed body, as ctx.req.body() reads it', async () => {
    const res = await app.request('/picks/body/json', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await res.json()).toEqual({ body: { a: 1 } })
  })
})
