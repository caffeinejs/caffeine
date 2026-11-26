import { describe, expect, it } from 'vitest'

import { compileChain, type ChainTarget } from './chain.js'
import { ErrNextCalledTwice } from './errors.js'
import type { MiddlewareFn, Next } from './middleware.js'
import { normalizePath, sanitizeURL } from './path.js'
import type { ResolvedMiddleware } from './pipeline.js'

class Target implements ChainTarget {
  sent = false
  readonly failures: unknown[] = []
  readonly logger = { error: (fields: { err?: unknown }) => void this.failures.push(fields.err) }
  readonly log: string[] = []

  readonly #url: string

  constructor(url: string) {
    this.#url = url
  }

  normalizedPath(): { path: string; error: Error | undefined } {
    return normalizePath(sanitizeURL(this.#url))
  }
}

function caffeine(handle: MiddlewareFn, path?: string): ResolvedMiddleware {
  return { path, hook: undefined, handle }
}

function logging(name: string, path?: string): ResolvedMiddleware {
  return caffeine((ctx, next) => {
    ;(ctx as unknown as Target).log.push(name)
    next()
  }, path)
}

function chain(middlewares: ResolvedMiddleware[], point: 'onRequest' | 'onSend' = 'onRequest') {
  return compileChain<Target>(middlewares, point)!
}

describe('compileChain', () => {
  // The work after `next` belongs to no step the request waits on: a failure there is logged, never left unhandled.
  it('logs a middleware that called next and rejected afterwards', async () => {
    const ctx = new Target('/x')
    const err = new Error('audit')
    const after = caffeine((async (_ctx: unknown, next: Next) => {
      next()
      await Promise.resolve()
      throw err
    }) as unknown as MiddlewareFn)

    chain([after])(ctx)
    await new Promise(resolve => setImmediate(resolve))

    expect(ctx.failures).toEqual([err])
  })

  it('is undefined with no middleware', () => {
    expect(compileChain<Target>([], 'onRequest')).toBe(undefined)
  })

  // A chain whose middleware all call next in the call costs no promise: the request goes on in the same tick.
  it('runs in order and stays synchronous while every middleware calls next at once', () => {
    const ctx = new Target('/x')

    expect(chain([logging('a'), logging('b')])(ctx)).toBe(undefined)
    expect(ctx.log).toEqual(['a', 'b'])
  })

  it('skips a middleware whose path the request is not under', () => {
    const ctx = new Target('/public/page')

    chain([logging('admin', '/admin'), logging('all')])(ctx)

    expect(ctx.log).toEqual(['all'])
  })

  it('waits for a next called later', async () => {
    const ctx = new Target('/x')
    const later = caffeine((_ctx, next) => void setImmediate(() => next()))

    const result = chain([later, logging('b')])(ctx)

    expect(ctx.log).toEqual([])
    await result
    expect(ctx.log).toEqual(['b'])
  })

  // Connect's convention: `next(null)` goes on, as `next()` does.
  it('goes on when next is called with null', () => {
    const ctx = new Target('/x')
    const nulled = caffeine((_ctx, next) => next(null as unknown as undefined))

    expect(() => chain([nulled, logging('b')])(ctx)).not.toThrow()
    expect(ctx.log).toEqual(['b'])
  })

  it('fails with what next was called with', async () => {
    const err = new Error('denied')
    const deny = caffeine((_ctx, next) => void setImmediate(() => next(err)))

    await expect(chain([deny, logging('b')])(new Target('/x'))).rejects.toBe(err)
  })

  it('fails with what a middleware throws before next', () => {
    const err = new Error('boom')

    expect(() =>
      chain([
        caffeine(() => {
          throw err
        }),
      ])(new Target('/x')),
    ).toThrow(err)
  })

  // A second next would run the rest of the chain, and the handler, a second time.
  it('throws ErrNextCalledTwice for a second next', () => {
    const twice = caffeine((_ctx, next) => {
      next()
      next()
    })

    expect(() => chain([twice])(new Target('/x'))).toThrow(ErrNextCalledTwice)
  })

  it('ends at onRequest once a middleware answered through the context', () => {
    const ctx = new Target('/x')
    const answer = caffeine((c, next) => {
      ;(c as unknown as Target).sent = true
      next()
    })

    chain([answer, logging('b')])(ctx)

    expect(ctx.log).toEqual([])
  })

  // At onSend the request is answered by definition: every middleware still runs.
  it('runs every middleware at onSend though the request is answered', () => {
    const ctx = new Target('/x')
    ctx.sent = true

    chain([logging('a'), logging('b')], 'onSend')(ctx)

    expect(ctx.log).toEqual(['a', 'b'])
  })
})
