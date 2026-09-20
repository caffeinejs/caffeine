import type { FastifyRequest } from 'fastify'

import { addRouteHook, type AdapterRouteOptions } from '../route_hooks.js'
import { runGuards } from './_run.js'
import type { CompiledGuard } from './compile.js'
import type { GuardContext, GuardTarget } from './guard.js'

/**
 * Attaches a callback-style route `onRequest` hook that runs `chain`. The hook is not `async`:
 * sync `guard()` results call `done()` without a microtask.
 */
export function attachGuardHook(
  routeDef: AdapterRouteOptions,
  chain: readonly CompiledGuard[],
  target: GuardTarget,
): void {
  addRouteHook(routeDef, 'onRequest', (request, _reply, done) => {
    runGuards(chain, (request as FastifyRequest).httpContext as GuardContext, target, done)
  })
}
