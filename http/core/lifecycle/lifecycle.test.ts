import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import {
  andThen,
  assertHookName,
  callbackEntry,
  isThenable,
  REQUEST_HOOK_NAMES,
  runAll,
  runErrorHooks,
  runHooks,
  runSendHooks,
  type ErrorEntry,
  type HookEntry,
  type SendEntry,
} from './lifecycle.js'

interface Ctx {
  sent: boolean
  log: number[]
}

function newCtx(): Ctx {
  return { sent: false, log: [] }
}

function step(n: number): HookEntry<Ctx> {
  return ctx => {
    ctx.log.push(n)
  }
}

describe('runHooks', () => {
  // A request whose hooks are all synchronous is answered in the tick it arrived: no promise is created for it.
  it('runs every entry in the tick it was called when none returns a thenable', () => {
    const ctx = newCtx()

    const result = runHooks([step(1), step(2), step(3)], ctx)

    expect(result).toBe(undefined)
    expect(ctx.log).toEqual([1, 2, 3])
  })

  it('waits on a thenable and goes on with the next entry', async () => {
    const ctx = newCtx()
    const slow: HookEntry<Ctx> = c => Promise.resolve().then(() => void c.log.push(1))

    const result = runHooks([slow, step(2)], ctx)

    expect(result).toBeInstanceOf(Promise)
    expect(ctx.log).toEqual([])
    await result
    expect(ctx.log).toEqual([1, 2])
  })

  // An entry that answered, a guard's denial or a cached answer, ends the hook point: later entries must not act on
  // a request already answered.
  it('stops after an entry that answered', async () => {
    const sync = newCtx()
    expect(runHooks([step(1), c => void (c.sent = true), step(3)], sync)).toBe(undefined)
    expect(sync.log).toEqual([1])

    const async = newCtx()
    await runHooks([step(1), c => Promise.resolve().then(() => void (c.sent = true)), step(3)], async)
    expect(async.log).toEqual([1])
  })

  // A request a timeout or a forced close already answered must not reach a hook that would act on it.
  it('runs no entry on a request already answered', () => {
    const ctx = { sent: true, log: [] as number[] }

    expect(runHooks([step(1), step(2)], ctx)).toBe(undefined)
    expect(ctx.log).toEqual([])
  })

  it('rejects with the error of an entry that throws after an asynchronous one', async () => {
    const err = new Error('boom')
    const ctx = newCtx()

    const result = runHooks(
      [
        () => Promise.resolve(),
        () => {
          throw err
        },
      ],
      ctx,
    )

    await expect(result).rejects.toBe(err)
  })
})

describe('callbackEntry', () => {
  it('settles synchronously when done is called at once', () => {
    const err = new Error('denied')

    expect(callbackEntry<Ctx>((_ctx, done) => done())(newCtx())).toBe(undefined)
    expect(() => callbackEntry<Ctx>((_ctx, done) => done(err))(newCtx())).toThrow(err)
  })

  it('waits for done called later', async () => {
    let finish: ((err?: Error) => void) | undefined
    const entry = callbackEntry<Ctx>((_ctx, done) => {
      finish = done
    })

    let settled = false
    const result = Promise.resolve(entry(newCtx())).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finish!()
    await result
    expect(settled).toBe(true)

    const err = new Error('late')
    const failing = callbackEntry<Ctx>((_ctx, done) => {
      finish = done
    })(newCtx())
    finish!(err)
    await expect(failing).rejects.toBe(err)
  })
})

describe('andThen', () => {
  it('hands a value on in the same tick and a thenable once it settles', async () => {
    expect(andThen(1, v => v + 1)).toBe(2)
    await expect(andThen(Promise.resolve(1), v => v + 1)).resolves.toBe(2)
  })
})

describe('runSendHooks', () => {
  const ctx = newCtx()

  it('keeps the payload when an entry returns undefined', () => {
    const keep: SendEntry<Ctx> = () => undefined

    expect(runSendHooks([keep], ctx, 'body')).toBe('body')
  })

  // `null` is a payload of its own, no body, and must not read as "keep".
  it('removes the body when an entry returns null', () => {
    const drop: SendEntry<Ctx> = () => null

    expect(runSendHooks([drop], ctx, 'body')).toBe(null)
  })

  it('settles without a promise when every entry is synchronous', () => {
    const upper: SendEntry<Ctx> = (_ctx, payload) => (payload as string).toUpperCase()

    const result = runSendHooks([upper, (_ctx, payload) => `${payload as string}!`], ctx, 'hi')

    expect(isThenable(result)).toBe(false)
    expect(result).toBe('HI!')
  })

  it('hands what an asynchronous entry resolves to on to the next', async () => {
    const slow: SendEntry<Ctx> = (_ctx, payload) => Promise.resolve(`${payload as string}-1`)
    const keep: SendEntry<Ctx> = () => Promise.resolve(undefined)

    await expect(runSendHooks([slow, keep, (_ctx, payload) => `${payload as string}-2`], ctx, 'a')).resolves.toBe(
      'a-1-2',
    )
  })

  // The caller holds only the payload it passed in, which a pipe an earlier entry built over it has locked: the stream
  // that entry returned is cancelled, and the cancellation reaches the source through the pipe.
  describe('when an entry fails after an earlier one returned a stream over the payload', () => {
    const failure = new Error('send')
    const piped: SendEntry<Ctx> = (_ctx, payload) => (payload as ReadableStream).pipeThrough(new TransformStream())
    const later: SendEntry<Ctx> = (_ctx, payload) =>
      Promise.resolve((payload as ReadableStream).pipeThrough(new TransformStream()))
    const throws: SendEntry<Ctx> = () => {
      throw failure
    }
    const rejects: SendEntry<Ctx> = () => Promise.reject(failure)

    it.each([
      ['a synchronous entry throws', [piped, throws]],
      ['an asynchronous entry rejects', [piped, rejects]],
      ['an entry throws after an asynchronous one', [later, throws]],
    ] as const)('cancels it when %s', async (_, entries) => {
      const cancelled = Promise.withResolvers<unknown>()
      const source = new ReadableStream<Uint8Array>({
        pull: () => undefined,
        cancel: reason => cancelled.resolve(reason),
      })

      await expect(Promise.resolve().then(() => runSendHooks(entries, newCtx(), source))).rejects.toBe(failure)
      expect(await cancelled.promise).toBe(failure)
    })

    it('leaves the payload it was handed to the caller when no entry replaced it', async () => {
      let cancelled = false
      const source = new ReadableStream<Uint8Array>({
        pull: () => undefined,
        cancel: () => {
          cancelled = true
        },
      })

      await expect(Promise.resolve().then(() => runSendHooks([throws], newCtx(), source))).rejects.toBe(failure)
      expect(cancelled).toBe(false)
      expect(source.locked).toBe(false)
    })
  })
})

describe('runErrorHooks', () => {
  const err = new Error('boom')

  // onError observes every failure, including one after the answer was written.
  it('runs every entry whether or not the request is answered', async () => {
    const ctx = { sent: true, log: [] as number[] }
    const seen: ErrorEntry<Ctx> = (c, e) => void c.log.push(e === err ? 1 : 0)

    await runErrorHooks([seen, () => Promise.resolve(), seen], ctx, err, () => undefined)

    expect(ctx.log).toEqual([1, 1])
  })

  // One broken observer must not silence the others: every onError hook sees every failure.
  it('reports a throw and still runs the next entry', async () => {
    const ctx = newCtx()
    const failure = new Error('hook')
    const failed: Error[] = []

    void runErrorHooks<Ctx>(
      [
        () => {
          throw failure
        },
        c => void c.log.push(2),
      ],
      ctx,
      err,
      e => failed.push(e),
    )
    await runErrorHooks<Ctx>([() => Promise.reject(failure), c => void c.log.push(3)], ctx, err, e => failed.push(e))

    expect(failed).toEqual([failure, failure])
    expect(ctx.log).toEqual([2, 3])
  })
})

describe('runAll', () => {
  // One failing onResponse hook must not keep the next from recording the request.
  it('reports a throw and still runs the next entry', async () => {
    const ctx = newCtx()
    const failure = new Error('hook')
    const failed: Error[] = []

    await runAll<Ctx>(
      [
        () => {
          throw failure
        },
        () => Promise.reject(failure),
        step(3),
      ],
      ctx,
      e => failed.push(e),
    )

    expect(failed).toEqual([failure, failure])
    expect(ctx.log).toEqual([3])
  })
})

describe('assertHookName', () => {
  it('refuses a point that is not a hook, naming the ones that exist', () => {
    expect(() => assertHookName('preValidation', REQUEST_HOOK_NAMES, 'on a route')).toThrow(ErrConfiguration)
    expect(() => assertHookName('preValidation', REQUEST_HOOK_NAMES, 'on a route')).toThrow(
      'Use one of "onRequest", "preHandler", "onSend", "onResponse", "onError"',
    )
  })
})
