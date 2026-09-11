import type { Container } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import type { Context } from '../context.js'
import type { ActionResult } from '../response.js'
import { ErrNextCalledTwice } from './errors.js'
import { type Middleware, type Next } from './middleware.js'
import { MiddlewarePipeline, compose } from './pipeline.js'

// The chain never touches the context, so a marker object is enough to assert it is the same one
// throughout.
const ctx = { marker: 'ctx' } as unknown as Context

type Handle = (ctx: Context, next: Next) => unknown

const chainOf = (...handles: Handle[]) => compose(handles as never)

describe('compose', () => {
  it('runs the middlewares in registration order, then the terminal', async () => {
    const order: string[] = []
    const chain = chainOf(
      async (_c, next) => {
        order.push('first:in')
        await next()
        order.push('first:out')
      },
      async (_c, next) => {
        order.push('second:in')
        await next()
        order.push('second:out')
      },
    )

    await chain(ctx, () => {
      order.push('terminal')
      return undefined
    })

    expect(order).toEqual(['first:in', 'second:in', 'terminal', 'second:out', 'first:out'])
  })

  it('passes the same context to every middleware', async () => {
    const seen: Context[] = []
    const chain = chainOf(
      (c, next) => {
        seen.push(c)
        return next()
      },
      (c, next) => {
        seen.push(c)
        return next()
      },
    )

    await chain(ctx, () => undefined)

    expect(seen).toEqual([ctx, ctx])
  })

  it('resolves next() with the terminal result, which a middleware may replace', async () => {
    let observed: unknown
    const chain = chainOf(async (_c, next) => {
      observed = await next()
      return { wrapped: observed }
    })

    const result = await chain(ctx, () => ({ id: 1 }))

    expect(observed).toEqual({ id: 1 })
    expect(result).toEqual({ wrapped: { id: 1 } })
  })

  it('short-circuits when a middleware does not call next: the terminal never runs', async () => {
    let terminalRan = false
    const chain = chainOf(
      () => 'answered',
      () => {
        throw new Error('the downstream middleware must not run')
      },
    )

    const result = await chain(ctx, () => {
      terminalRan = true
      return undefined
    })

    expect(result).toBe('answered')
    expect(terminalRan).toBe(false)
  })

  it('rejects a second next() from the same middleware', async () => {
    const chain = chainOf(async (_c, next) => {
      await next()
      await next()
    })

    await expect(chain(ctx, () => undefined) as Promise<unknown>).rejects.toThrow(ErrNextCalledTwice)
  })

  it('rejects a second next() from a synchronous middleware too', () => {
    const chain = chainOf((_c, next) => {
      next()
      return next()
    })

    expect(() => chain(ctx, () => undefined)).toThrow(ErrNextCalledTwice)
  })

  it('allows the same terminal to run once per request rather than once per composition', async () => {
    const chain = chainOf((_c, next) => next())
    const seen: number[] = []

    await chain(ctx, () => void seen.push(1))
    await chain(ctx, () => void seen.push(2))

    expect(seen).toEqual([1, 2])
  })

  // A synchronous throw stays synchronous: both call sites run the chain inside a try/catch of their own
  // (Fastify's hook runner and its route handler), and an upstream `try { await next() }` catches it the
  // same way. Wrapping it in a rejected promise would cost every request a promise to make one path tidier.
  it('lets a synchronous middleware error propagate synchronously', () => {
    const chain = chainOf(() => {
      throw new Error('boom')
    })

    expect(() => chain(ctx, () => undefined)).toThrow('boom')
  })

  it('propagates an asynchronous middleware error as a rejection', async () => {
    const chain = chainOf(async () => {
      throw new Error('boom')
    })

    await expect(chain(ctx, () => undefined) as Promise<unknown>).rejects.toThrow('boom')
  })

  it('propagates a terminal error through the middlewares that awaited it', async () => {
    let caught: unknown
    const chain = chainOf(async (_c, next) => {
      try {
        await next()
      } catch (error) {
        caught = error
        throw error
      }
    })

    await expect(chain(ctx, () => Promise.reject(new Error('handler failed'))) as Promise<unknown>).rejects.toThrow(
      'handler failed',
    )
    expect((caught as Error).message).toBe('handler failed')
  })

  it('runs the terminal directly when there is no middleware', async () => {
    const result = await chainOf()(ctx, () => 'bare')
    expect(result).toBe('bare')
  })

  it('stays synchronous when every middleware is synchronous', () => {
    const chain = chainOf(
      (_c, next) => next(),
      (_c, next) => next(),
    )

    // Not a promise: a chain that never awaits must not manufacture one, or every request pays a microtask.
    expect(chain(ctx, () => 'sync')).toBe('sync')
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

  it('wraps the dispatch when the handler group has a middleware', async () => {
    const pipeline = new MiddlewarePipeline()
    pipeline.add(async (_c, next) => ({ data: await next() }), 'handler')
    pipeline.setupAll(container)

    const dispatch = (_request: unknown): string => 'result'
    const wrapped = pipeline.wrapHandler(dispatch)

    expect(wrapped).not.toBe(dispatch)
    expect(await wrapped({ httpContext: ctx })).toEqual({ data: 'result' })
  })

  it('reports whether a middleware type is registered', () => {
    class Marker implements Middleware {
      handle(_c: Context, next: Next): ActionResult {
        return next()
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
