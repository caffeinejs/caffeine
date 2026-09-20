import { describe, it, expect } from 'vitest'

import { ErrHTTPForbidden } from '../error/http.js'
import { runGuards } from './_run.js'
import type { CompiledGuard } from './compile.js'
import { GuardResult, type Guard, type GuardContext, type GuardTarget } from './guard.js'

const ctx = {} as GuardContext
const target: GuardTarget = { handler: 'handler' }

function instance(guard: Guard['guard']): CompiledGuard {
  return { kind: 'instance', instance: { guard } }
}

/** A guard the container can only build per request — and, here, cannot build at all. */
function unresolvable(err: unknown): CompiledGuard {
  return {
    kind: 'provider',
    provider: {
      get(): Guard {
        throw err
      },
    },
  }
}

function run(chain: CompiledGuard[]): Promise<Error | undefined> {
  return new Promise(resolve => {
    runGuards(chain, ctx, target, resolve)
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

  it('falls back to the default message when the denial names no reason', async () => {
    const err = await run([instance(() => GuardResult.deny(''))])

    expect(err).toBeInstanceOf(ErrHTTPForbidden)
    expect(err?.message).toBe('Resource forbidden')
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

    expect(err).toBeInstanceOf(ErrHTTPForbidden)
    expect(order).toEqual(['first', 'deny'])
  })

  it('calls done once when every guard allows', async () => {
    let calls = 0

    await new Promise<void>(resolve => {
      runGuards([instance(() => Promise.resolve(true)), instance(() => true)], ctx, target, () => {
        calls++
        resolve()
      })
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(calls).toBe(1)
  })
})
