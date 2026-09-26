import { describe, it, expect } from 'vitest'

import type { CompiledGuard } from './compile.js'
import type { BaseGuard } from './guard.js'
import { runGuards, type GuardDenial } from './run.js'

interface Input {
  readonly kind: 'test'
}

type TestGuard = BaseGuard<Input>

const input: Input = { kind: 'test' }

/** Records what the runner handed the transport, so a test can tell the two outcomes and the reason apart. */
class Denied extends Error {
  constructor(
    readonly outcome: 'forbidden' | 'unauthenticated',
    readonly reason: string,
  ) {
    super(reason || outcome)
  }
}

const deny: GuardDenial = (outcome, reason) => new Denied(outcome, reason)

function instance(guard: TestGuard['guard']): CompiledGuard<TestGuard> {
  return { kind: 'instance', instance: { guard } }
}

/** A guard the container can only build per request — and, here, cannot build at all. */
function unresolvable(err: unknown): CompiledGuard<TestGuard> {
  return {
    kind: 'provider',
    provider: {
      get(): TestGuard {
        throw err
      },
    },
  }
}

function run(chain: CompiledGuard<TestGuard>[]): Promise<Error | undefined> {
  return new Promise(resolve => {
    runGuards(chain, input, deny, resolve)
  })
}

describe('run_guards', () => {
  it('reports a guard it cannot resolve after an async guard, rather than leaving the request pending', async () => {
    const boom = new Error('cannot build')

    await expect(run([instance(() => Promise.resolve(true)), unresolvable(boom)])).resolves.toBe(boom)
  })

  it('does not read a guard that rejected without a reason as an allow', async () => {
    // A falsy error means "continue" to the caller, so the request would be served with the guard skipped.
    await expect(run([instance(() => Promise.reject())])).resolves.toBeInstanceOf(Error)
  })

  it('does not read a guard that threw a falsy value as an allow', async () => {
    await expect(
      run([
        instance(() => {
          throw undefined
        }),
      ]),
    ).resolves.toBeInstanceOf(Error)
  })

  it('reports a guard that resolved no result, rather than leaving the request pending', async () => {
    await expect(run([instance(() => Promise.resolve(undefined as unknown as boolean))])).resolves.toBeInstanceOf(Error)
  })

  it('allows an outcome that is ok', async () => {
    await expect(run([instance(() => ({ ok: true, reason: '' }))])).resolves.toBeUndefined()
  })

  it('hands every guard the input the transport built', async () => {
    const seen: Input[] = []

    await run([
      instance(i => {
        seen.push(i)
        return Promise.resolve(true)
      }),
      instance(i => {
        seen.push(i)
        return true
      }),
    ])

    expect(seen).toEqual([input, input])
    expect(seen[0]).toBe(input)
    expect(seen[1]).toBe(input)
  })

  it('answers a bare false with the error the transport built for a forbidden denial with no reason', async () => {
    const err = await run([instance(() => false)])

    expect(err).toBeInstanceOf(Denied)
    expect(err).toMatchObject({ outcome: 'forbidden', reason: '' })
  })

  it('hands the transport the reason a denial gave', async () => {
    const err = await run([instance(() => ({ ok: false, reason: 'token expired' }))])

    expect(err).toMatchObject({ outcome: 'forbidden', reason: 'token expired' })
  })

  it('tells the transport an unauthenticated denial apart from a forbidden one', async () => {
    // The transport answers them with different statuses (401 against 403), so collapsing them would tell a
    // caller who is not signed in that they are not allowed.
    const err = await run([instance(() => Promise.resolve({ ok: false, reason: 'no token', unauthenticated: true }))])

    expect(err).toMatchObject({ outcome: 'unauthenticated', reason: 'no token' })
  })

  it('keeps declaration order and stops at the first denial across an async guard', async () => {
    const order: string[] = []

    const err = await run([
      instance(() => {
        order.push('first')
        return Promise.resolve(true)
      }),
      instance(() => {
        order.push('deny')
        return false
      }),
      instance(() => {
        order.push('unreached')
        return true
      }),
    ])

    expect(err).toBeInstanceOf(Denied)
    expect(order).toEqual(['first', 'deny'])
  })

  it('calls done once when every guard allows', async () => {
    let calls = 0

    await new Promise<void>(resolve => {
      runGuards([instance(() => Promise.resolve(true)), instance(() => true)], input, deny, () => {
        calls++
        resolve()
      })
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(calls).toBe(1)
  })

  it('reaches done without a microtask when every guard is synchronous', () => {
    let called = false

    runGuards([instance(() => true), instance(() => ({ ok: true, reason: '' }))], input, deny, () => {
      called = true
    })

    expect(called).toBe(true)
  })
})
