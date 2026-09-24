import type { Arm, CallSpec, OptionalCall, RequiredCall } from './arm.js'
import { ErrBFFTimeout } from './errors.js'

/** What `join` returns: a required key is the value, an optional key is an {@link Arm}. */
export type Joined<S> = {
  [K in keyof S]: S[K] extends RequiredCall<infer T> ? T : S[K] extends OptionalCall<infer T> ? Arm<T> : never
}

/**
 * Runs every arm together under one signal.
 *
 * A required failure aborts that signal and rejects with the original error, so no partial screen is returned.
 * An optional failure becomes `{ ok: false, reason }`. The signal aborting rejects the whole join: an optional
 * arm is not a place to report that the caller has gone.
 */
export function join<S extends Record<string, CallSpec<unknown>>>(
  source: { readonly signal: AbortSignal },
  spec: S,
): Promise<Joined<S>> {
  const parent = source.signal
  if (parent.aborted) {
    return Promise.reject(parent.reason)
  }

  return run(parent, spec)
}

async function run<S extends Record<string, CallSpec<unknown>>>(parent: AbortSignal, spec: S): Promise<Joined<S>> {
  const controller = new AbortController()
  const onParent = (): void => {
    controller.abort(parent.reason)
  }
  parent.addEventListener('abort', onParent, { once: true })

  if (parent.aborted) {
    parent.removeEventListener('abort', onParent)
    throw parent.reason
  }

  const tasks = Object.keys(spec).map(async key => {
    const arm = spec[key] as CallSpec<unknown>

    try {
      const value: unknown = await arm.call(controller.signal)
      const out = arm.kind === 'optional' ? { ok: true as const, value } : value

      return { key, out }
    } catch (error) {
      if (arm.kind === 'required') {
        controller.abort(error)
        throw error
      }

      const reason = error instanceof ErrBFFTimeout ? ('timeout' as const) : ('unavailable' as const)

      return { key, out: { ok: false as const, reason } }
    }
  })

  try {
    const rows = await Promise.all(tasks)
    if (parent.aborted) {
      throw parent.reason
    }

    const screen = {} as Joined<S>
    for (const row of rows) {
      screen[row.key as keyof S] = row.out as Joined<S>[keyof S]
    }

    return screen
  } catch (error) {
    if (parent.aborted) {
      throw parent.reason
    }

    throw error
  } finally {
    parent.removeEventListener('abort', onParent)
  }
}
