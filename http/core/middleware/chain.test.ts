import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { compileChain, type ChainTarget } from './chain.js'
import { ErrNextCalledTwice } from './errors.js'
import type { MiddlewareFn, Next, NodeMiddleware } from './middleware.js'
import { normalizePath, sanitizeURL } from './path.js'
import type { ResolvedMiddleware } from './pipeline.js'

class Target implements ChainTarget {
  sent = false
  readonly failures: unknown[] = []
  readonly logger = { error: (fields: { err?: unknown }) => void this.failures.push(fields.err) }
  readonly log: string[] = []
  readonly nodeURLs: string[] = []
  answerNode = false

  readonly req: { url: string }
  readonly #url: string

  constructor(url: string) {
    this.#url = url
    this.req = { url }
  }

  mount(url: string | undefined): void {
    this.req.url = url ?? this.#url
  }

  normalizedPath(): { path: string; error: Error | undefined } {
    return normalizePath(sanitizeURL(this.#url), {})
  }

  runNodeMiddleware(fn: NodeMiddleware, url: string, next: Next, answered: () => void): void {
    this.nodeURLs.push(url)
    if (this.answerNode) {
      answered()
      return
    }
    fn({} as never, {} as never, next)
  }
}

function caffeine(handle: MiddlewareFn, path?: string): ResolvedMiddleware {
  return { path, hook: undefined, fn: () => undefined, handle }
}

function node(fn: NodeMiddleware, path?: string): ResolvedMiddleware {
  return { path, hook: undefined, fn, handle: undefined }
}

function logging(name: string, path?: string): ResolvedMiddleware {
  return caffeine((ctx, next) => {
    ;(ctx as unknown as Target).log.push(name)
    next()
  }, path)
}

function chain(middlewares: ResolvedMiddleware[], point: 'onRequest' | 'onSend' = 'onRequest', nodeMiddleware = true) {
  return compileChain<Target>(middlewares, point, {}, nodeMiddleware, 'fetch application')!
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
    expect(compileChain<Target>([], 'onRequest', {}, true, 'fetch application')).toBe(undefined)
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

  // Connect's convention, which Node middleware follows: `next(null)` goes on, as `next()` does.
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

  // As connect mounts it: under its prefix a middleware sees the rest of the URL, and the request gets its own URL back
  // once it calls next.
  it('hands a context middleware the rest of the URL under its prefix, and gives it back', () => {
    const ctx = new Target('/admin/users?page=2')
    const seen: string[] = []

    chain([
      caffeine((c, next) => {
        seen.push((c as unknown as Target).req.url)
        next()
      }, '/admin'),
      caffeine((c, next) => {
        seen.push((c as unknown as Target).req.url)
        next()
      }),
    ])(ctx)

    expect(seen).toEqual(['/users?page=2', '/admin/users?page=2'])
    expect(ctx.req.url).toBe('/admin/users?page=2')
  })

  it('hands a Node middleware the rest of the path under its prefix', () => {
    const ctx = new Target('/admin/users?page=2')

    chain([node((_req, _res, next) => next(), '/admin')])(ctx)

    expect(ctx.nodeURLs).toEqual(['/users?page=2'])
  })

  it('settles when a Node middleware answered without next', () => {
    const ctx = new Target('/x')
    ctx.answerNode = true

    expect(chain([node(() => undefined), logging('b')])(ctx)).toBe(undefined)
    expect(ctx.log).toEqual([])
  })

  it('refuses a Node middleware where the runtime has no Node request', () => {
    expect(() => chain([node(function helmet() {})], 'onRequest', false)).toThrow(ErrConfiguration)
    expect(() => chain([node(function helmet() {})], 'onRequest', false)).toThrow(
      'Cannot install the Node middleware "helmet" on the fetch application: it has no Node request',
    )
  })
})
