import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import { compileArgs } from '../adapter_handler_parameters.js'
import { $p } from '../route_picker.js'

function asReq(partial: object): FastifyRequest {
  return partial as FastifyRequest
}

/**
 * Resolved the way a route resolves it, rather than by reaching for `pick.picker`. A built-in carries no
 * picker at all — the adapter reads it by `type` — so anything asserted against that field alone would be
 * blind to exactly the case `$p.map` was unable to handle.
 */
async function argOf(pick: ParameterPickOptions<never>, req: object): Promise<unknown> {
  const args = await compileArgs([pick] as never)(asReq(req), {} as FastifyReply)
  return args[0]
}

const id = $p.pick(req => (req as { params: { id: string } }).params.id)
const queryQ = $p.pick(req => (req as { query: { q?: string } }).query.q)

describe('$p.map', () => {
  it('leaves an unmapped picker without a picker function', () => {
    expect($p.param('id').picker).toBeUndefined()
    expect($p.body().picker).toBeUndefined()
  })

  it('does not mutate the input pick', () => {
    const source = $p.pick(req => (req as { params: { id: string } }).params.id)
    const mapped = $p.map(source, Number)

    expect(source.transform).toBeUndefined()
    expect(mapped).not.toBe(source)
    expect(mapped.transform).toBeTypeOf('function')
  })

  it('maps a picked value through a sync function', async () => {
    const mapped = $p.map(id, Number)

    expect(mapped.async).toBeUndefined()
    await expect(argOf(mapped, { params: { id: '42' } })).resolves.toBe(42)
  })

  // The reported defect: a built-in has no picker to chain onto, so mapping one used to throw
  // `Cannot map: no picker function` while the controller module was still loading.
  it('maps a built-in pick', async () => {
    const mapped = $p.map($p.param('id'), (value: string) => Number(value))

    await expect(argOf(mapped, { params: { id: '7' } })).resolves.toBe(7)
    await expect(
      argOf(
        $p.map($p.body(), (b: { n: number }) => b.n),
        { body: { n: 3 } },
      ),
    ).resolves.toBe(3)
  })

  it('maps the request context, which is how a handler reaches past what a built-in returns', async () => {
    const mapped = $p.map($p.context(), (ctx: { user: { name: string } }) => ctx.user.name)

    await expect(argOf(mapped, { httpContext: { user: { name: 'ada' } } })).resolves.toBe('ada')
  })

  it('composes nested maps', async () => {
    const mapped = $p.map(
      $p.map(queryQ, (s: string | undefined) => s ?? ''),
      (s: string) => s.trim(),
    )

    await expect(argOf(mapped, { query: { q: '  hi  ' } })).resolves.toBe('hi')
  })

  it('composes nested maps over a built-in', async () => {
    const mapped = $p.map(
      $p.map($p.param('id'), (s: string) => s.trim()),
      (s: string) => Number(s),
    )

    await expect(argOf(mapped, { params: { id: ' 5 ' } })).resolves.toBe(5)
  })

  it('maps a custom $p.pick', async () => {
    const mapped = $p.map(
      $p.pick(req => (req as { url: string }).url),
      (url: string) => url.toUpperCase(),
    )

    await expect(argOf(mapped, { url: '/pets' })).resolves.toBe('/PETS')
  })

  it('keeps async when mapping an async pick with a sync function', async () => {
    const mapped = $p.map(
      $p.pick(async () => 'unsigned', { async: true }),
      (v: string) => v,
    )

    expect(mapped.async).toBe(true)
    await expect(argOf(mapped, {})).resolves.toBe('unsigned')
  })

  // An async built-in settles before the transform sees it, so a transform is written against the value.
  it('awaits an async built-in before transforming it', async () => {
    const mapped = $p.map($p.signedCookie('tok'), (value: unknown) => `[${String(value)}]`)

    expect(mapped.async).toBe(true)
    await expect(
      argOf(mapped, {
        cookies: { tok: 'signed' },
        unsignCookie: () => ({ valid: true, value: 'plain', renew: false }),
      }),
    ).resolves.toBe('[plain]')
  })

  it('resolves $p.map(..., { async: true }) before returning', async () => {
    const mapped = $p.map(id, async (value: string) => `id:${value}`, { async: true })

    expect(mapped.async).toBe(true)
    await expect(argOf(mapped, { params: { id: '7' } })).resolves.toBe('id:7')
  })

  it('treats mapAsync as map with { async: true }', async () => {
    const viaMap = $p.map(id, async (value: string) => Number(value), { async: true })
    const viaAsyncMap = $p.mapAsync(id, async (value: string) => Number(value))

    expect(viaMap.async).toBe(true)
    expect(viaAsyncMap.async).toBe(true)
    await expect(argOf(viaAsyncMap, { params: { id: '9' } })).resolves.toBe(9)
  })

  it('composes mapAsync over a sync map', async () => {
    const mapped = $p.mapAsync(
      $p.map(id, (value: string) => Number(value)),
      async (n: number) => n * 2,
    )

    await expect(argOf(mapped, { params: { id: '4' } })).resolves.toBe(8)
  })

  it('propagates a mapper throw', async () => {
    const mapped = $p.map(id, () => {
      throw new Error('bad id')
    })

    await expect(argOf(mapped, { params: { id: 'x' } })).rejects.toThrow('bad id')
  })
})

describe('$p.user', () => {
  const principal = {
    authenticated: true,
    findFirst: (type: string) => (type === 'sub' ? { type, value: 'u-1', issuer: '' } : undefined),
  }

  it('picks the authenticated principal off the context', async () => {
    await expect(argOf($p.user(), { httpContext: { user: principal } })).resolves.toBe(principal)
  })

  // There is no `p.claim()`: the principal's own lookup API is richer than a picker would be, and mapping
  // over it composes the shorthand for whoever wants one.
  it('composes with map to read one claim', async () => {
    const claim = $p.map($p.user(), (u: typeof principal) => u.findFirst('sub')?.value)

    await expect(argOf(claim, { httpContext: { user: principal } })).resolves.toBe('u-1')
  })
})
