import { STATUS_CODES } from 'http'
import type { FastifyRequest } from 'fastify'
import { addRouteHook, type AdapterRouteOptions } from '../internal/route_hooks.js'
import { ErrHTTPForbidden } from '../error/http.js'
import type { Guard, GuardContext, GuardInput, GuardResult, GuardReturn } from './guard.js'
import type { CompiledGuard } from './compile.js'
import { kGuardOptions } from './keys.js'

const RESOURCE_FORBIDDEN = 'Resource forbidden'

/**
 * Attaches a callback-style route `onRequest` hook that runs `chain`. The hook is not `async`:
 * sync `canActivate` results call `done()` without a microtask.
 */
export function attachGuardHook(routeDef: AdapterRouteOptions, chain: CompiledGuard[]): void {
  addRouteHook(routeDef, 'onRequest', (request, _reply, done) => {
    const ctx = (request as FastifyRequest).httpContext as GuardContext | undefined
    if (ctx == null) {
      done()
      return
    }

    const input: GuardInput<unknown> = {
      context: ctx,
      target: { clazz: routeDef.config?.caffeine?.controller, handler: routeDef.handler.name },
      opts: routeDef.config?.[kGuardOptions],
    }

    runGuards(input, chain, 0, done)
  })
}

function runGuards(
  input: GuardInput<unknown>,
  chain: CompiledGuard[],
  start: number,
  done: (err?: Error) => void,
): void {
  for (let i = start; i < chain.length; i++) {
    const guard = resolve(chain[i])
    let result: GuardReturn
    try {
      result = guard.canActivate(input)
    } catch (err) {
      done(err as Error)
      return
    }

    if (isThenable<boolean | GuardResult>(result)) {
      result.then(
        value => {
          const denied = denialOf(value)
          if (denied) {
            done(denied)
            return
          }
          runGuards(input, chain, i + 1, done)
        },
        done,
      )
      return
    }

    const denied = denialOf(result)
    if (denied) {
      done(denied)
      return
    }
  }

  done()
}

function resolve(entry: CompiledGuard): Guard {
  return entry.kind === 'instance' ? entry.instance : entry.provider.get()
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

function denialOf(result: boolean | GuardResult): ErrHTTPForbidden | undefined {
  if (result === true) {
    return undefined
  }

  if (result === false) {
    return new ErrHTTPForbidden(RESOURCE_FORBIDDEN)
  }

  if (result.ok) {
    return undefined
  }

  const message = result.reason ?? RESOURCE_FORBIDDEN

  return new ErrHTTPForbidden(message, {
    body: {
      statusCode: 403,
      error: STATUS_CODES[403] ?? 'Forbidden',
      code: 'ERR_HTTP_FORBIDDEN',
      message,
    },
  })
}
