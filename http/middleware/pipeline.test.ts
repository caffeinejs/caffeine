import type { Container } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import type { Context } from '../context.js'
import { ErrNextCalledTwice } from './errors.js'
import { type Middleware, type Next } from './middleware.js'
import { MiddlewarePipeline, compose } from './pipeline.js'

// The chain never touches the context, so a marker object is enough to assert it is the same one
// throughout.
const ctx = { marker: 'ctx' } as unknown as Context

type Handle = (ctx: Context, next: Next) => void

const chainOf = (...handles: Handle[]) => compose(handles as never)

describe('compose', () => {
  it('runs the middlewares in registration order, then the terminal', () => {
    const order: string[] = []
    const chain = chainOf(
      (_c, next) => {
        order.push('first')
        next()
      },
      (_c, next) => {
        order.push('second')
        next()
      },
    )

    chain(ctx, () => {
      order.push('terminal')
    })

    expect(order).toEqual(['first', 'second', 'terminal'])
  })

  it('passes the same context to every middleware', () => {
    const seen: Context[] = []
    const chain = chainOf(
      (c, next) => {
        seen.push(c)
        next()
      },
      (c, next) => {
        seen.push(c)
        next()
      },
    )

    chain(ctx, () => undefined)

    expect(seen).toEqual([ctx, ctx])
  })

  it('short-circuits when a middleware does not call next: the terminal never runs', () => {
    let terminalRan = false
    const chain = chainOf(
      () => undefined,
      () => {
        throw new Error('the downstream middleware must not run')
      },
    )

    chain(ctx, () => {
      terminalRan = true
    })

    expect(terminalRan).toBe(false)
  })

  it('skips the rest of the chain when next is given an error', () => {
    const seen: Error[] = []
    const chain = chainOf(
      (_c, next) => next(new Error('nope')),
      () => {
        throw new Error('the downstream middleware must not run')
      },
    )

    chain(ctx, err => {
      if (err) {
        seen.push(err)
      }
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].message).toBe('nope')
  })

  it('rejects a second next() from the same middleware', () => {
    const chain = chainOf((_c, next) => {
      next()
      next()
    })

    expect(() => chain(ctx, () => undefined)).toThrow(ErrNextCalledTwice)
  })

  it('allows the same terminal to run once per request rather than once per composition', () => {
    const chain = chainOf((_c, next) => next())
    const seen: number[] = []

    chain(ctx, () => void seen.push(1))
    chain(ctx, () => void seen.push(2))

    expect(seen).toEqual([1, 2])
  })

  // A synchronous throw stays synchronous: both call sites run the chain inside a try/catch of their own
  // (Fastify's hook runner and its route handler). Wrapping it in a rejected promise would cost every
  // request a promise to make one path tidier.
  it('lets a synchronous middleware error propagate synchronously', () => {
    const chain = chainOf(() => {
      throw new Error('boom')
    })

    expect(() => chain(ctx, () => undefined)).toThrow('boom')
  })

  it('forwards an asynchronous middleware rejection to the terminal', async () => {
    const err = await new Promise<Error | undefined>(resolve => {
      chainOf(async () => {
        throw new Error('boom')
      })(ctx, e => resolve(e))
    })

    expect(err?.message).toBe('boom')
  })

  it('runs the terminal directly when there is no middleware', () => {
    let ran = false
    chainOf()(ctx, () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('stays synchronous when every middleware is synchronous', () => {
    const chain = chainOf(
      (_c, next) => next(),
      (_c, next) => next(),
    )

    let ran = false
    const result = chain(ctx, () => {
      ran = true
    })

    expect(ran).toBe(true)
    expect(result).toBeUndefined()
  })
})

describe('MiddlewarePipeline', () => {
  const container = {} as Container

  it('returns the dispatch untouched when the handler group is empty', () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.setupAll(container)

    const dispatch = (): string => 'result'

    expect(pipeline.wrapHandler(dispatch)).toBe(dispatch)
  })

  it('runs dispatch when the handler group has a middleware that continues', () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.add((_c, next) => next(), 'handler')
    pipeline.setupAll(container)

    const dispatch = (_request: unknown): string => 'result'
    const wrapped = pipeline.wrapHandler(dispatch)

    expect(wrapped).not.toBe(dispatch)
    expect(wrapped({ httpContext: ctx })).toBe('result')
  })

  it('reports whether a middleware type is registered', () => {
    class Marker implements Middleware {
      handle(_c: Context, next: Next): void {
        next()
      }
    }

    const pipeline = new MiddlewarePipeline()
    pipeline.add(new Marker(), 'handler')

    expect(pipeline.has(Marker)).toBe(true)
    expect(pipeline.has(MiddlewarePipeline)).toBe(false)
  })

  it('registers no hook for a group nobody used', () => {
    const added: string[] = []
    const server = { addHook: (hook: string) => void added.push(hook) } as never

    const pipeline = new MiddlewarePipeline()
    pipeline.add(() => undefined, 'handler')
    pipeline.setupAll(container)
    pipeline.installHooks(server)

    // The handler group is not a Fastify hook, and every other group is empty.
    expect(added).toEqual([])
  })

  it('registers exactly one hook per non-empty group, whatever its size', () => {
    const added: string[] = []
    const server = { addHook: (hook: string) => void added.push(hook) } as never

    const pipeline = new MiddlewarePipeline()
    pipeline.add((_c, next) => next(), 'onRequest')
    pipeline.add((_c, next) => next(), 'onRequest')
    pipeline.add((_c, next) => next(), 'preHandler')
    pipeline.setupAll(container)
    pipeline.installHooks(server)

    expect(added).toEqual(['onRequest', 'preHandler'])
  })

  it('refuses a registration once the pipeline is composed', () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.setupAll(container)

    expect(() => pipeline.add(() => undefined, 'handler')).toThrow('the application is already started')
  })
})
