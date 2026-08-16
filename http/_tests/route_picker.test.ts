import { describe, expect, it } from 'vitest'

import type { ParameterPicker, ParameterPickOptions } from '@caffeinejs/std/framework'

function compose<R>(req: R, ...fns: Array<(req: R) => Array<unknown>>): Array<unknown> {
  return fns.reduce((acc, fn) => [...acc, ...fn(req)], [] as Array<unknown>)
}

describe('Request Parameter', () => {
  interface Request {
    path: Record<string, unknown>
    query: Record<string, unknown>
    body: Record<string, unknown>
  }

  function testTransformer(parameters: Array<ParameterPickOptions<Request>>): ParameterPicker<Request> {
    return (req: Request) => compose<Request>(req, ...parameters.map(parameter => {
      switch (parameter.type) {
        case 'path':
          return (req: Request) => [req.path[parameter.name as string]]
        case 'query':
          return (req: Request) => [req.query[parameter.name as string]]
        case 'body':
          return (req: Request) => [req.body[parameter.name as string]]
        default:
          return (_req: Request) => []
      }
    }))
  }

  describe('given a request expressed as an object', () => {
    it('should extract path, query and body parameters', () => {
      const req: Request = {
        path: { id: '1' },
        query: { name: 'John' },
        body: { name: 'Doe' },
      }

      const result = testTransformer([
        { name: 'id', type: 'path' },
        { name: 'name', type: 'query' },
        { name: 'name', type: 'body' },
      ])(req)

      expect(result).toEqual(['1', 'John', 'Doe'])
    })

    it('should return empty array for unhandled parameter types', () => {
      const req: Request = { path: {}, query: {}, body: {} }

      const result = testTransformer([
        { name: 'token', type: 'header' },
      ])(req)

      expect(result).toEqual([])
    })
  })

  it('should compose request parameters', () => {
    const req: Request = {
      path: { id: '1' },
      query: { name: 'John' },
      body: { name: 'John' },
    }

    const Path = (field: string) => (req: Request) => [req.path[field]]
    const Query = (field: string) => (req: Request) => [req.query[field]]
    const Body = (field: string) => (req: Request) => [req.body[field]]

    const result = compose(req, Path('id'), Query('name'), Body('name'))

    expect(result).toEqual(['1', 'John', 'John'])
  })
})
