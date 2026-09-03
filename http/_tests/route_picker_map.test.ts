import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'

import { $p } from '../route_picker.js'

function asReq(partial: object): FastifyRequest {
  return partial as FastifyRequest
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
    const original = source.picker
    const mapped = $p.map(source, Number)

    expect(source.picker).toBe(original)
    expect(mapped).not.toBe(source)
    expect(mapped.picker).not.toBe(original)
  })

  it('maps a picked value through a sync function', () => {
    const mapped = $p.map(id, Number)
    expect(mapped.async).toBeUndefined()
    expect(mapped.picker!(asReq({ params: { id: '42' } }))).toBe(42)
  })

  it('composes nested maps at decorate time', () => {
    const mapped = $p.map(
      $p.map(queryQ, (s: string | undefined) => s ?? ''),
      (s: string) => s.trim(),
    )
    expect(mapped.picker!(asReq({ query: { q: '  hi  ' } }))).toBe('hi')
  })

  it('maps a custom $p.pick', () => {
    const mapped = $p.map(
      $p.pick(req => (req as { url: string }).url),
      (url: string) => url.toUpperCase(),
    )
    expect(mapped.picker!(asReq({ url: '/pets' }))).toBe('/PETS')
  })

  it('keeps async when mapping an async pick with a sync function', async () => {
    const mapped = $p.map(
      $p.pick(async () => 'unsigned', { async: true }),
      (v: string) => v,
    )
    expect(mapped.async).toBe(true)
    await expect(mapped.picker!(asReq({}))).resolves.toBe('unsigned')
  })

  it('resolves $p.map(..., { async: true }) before returning', async () => {
    const mapped = $p.map(id, async (value: string) => `id:${value}`, { async: true })
    expect(mapped.async).toBe(true)
    await expect(mapped.picker!(asReq({ params: { id: '7' } }))).resolves.toBe('id:7')
  })

  it('treats asyncMap as map with { async: true }', async () => {
    const viaMap = $p.map(id, async (value: string) => Number(value), { async: true })
    const viaAsyncMap = $p.mapAsync(id, async (value: string) => Number(value))
    expect(viaMap.async).toBe(true)
    expect(viaAsyncMap.async).toBe(true)
    await expect(viaAsyncMap.picker!(asReq({ params: { id: '9' } }))).resolves.toBe(9)
  })

  it('composes asyncMap over a sync map', async () => {
    const mapped = $p.mapAsync(
      $p.map(id, (value: string) => Number(value)),
      async (n: number) => n * 2,
    )
    await expect(mapped.picker!(asReq({ params: { id: '4' } }))).resolves.toBe(8)
  })

  it('throws when the argument has no picker function', () => {
    expect(() => $p.map($p.param('id'), Number)).toThrow('Cannot map: no picker function')
    expect(() => $p.mapAsync($p.body(), async v => v)).toThrow('Cannot map: no picker function')
  })

  it('propagates a mapper throw', () => {
    const mapped = $p.map(id, () => {
      throw new Error('bad id')
    })
    expect(() => mapped.picker!(asReq({ params: { id: 'x' } }))).toThrow('bad id')
  })
})
