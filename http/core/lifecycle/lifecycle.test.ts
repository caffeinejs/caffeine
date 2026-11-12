import { describe, expect, it } from 'vitest'

import { andThen, callbackEntry, runHooks, type HookEntry } from './lifecycle.js'

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
