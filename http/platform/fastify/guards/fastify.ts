import { runGuards, type CompiledGuard } from '@caffeinejs/std/framework'
import type { FastifyRequest } from 'fastify'

import { httpGuardDenial, type Guard, type GuardContext, type GuardTarget } from '../../../core/guards/guard.js'
import { addRouteHook, type AdapterRouteOptions } from '../routing/route_options.js'

/**
 * Attaches a callback-style route `onRequest` hook that runs `chain`. The hook is not `async`:
 * sync `guard()` results call `done()` without a microtask.
 */
export function attachGuardHook(
  routeDef: AdapterRouteOptions,
  chain: readonly CompiledGuard<Guard>[],
  target: GuardTarget,
): void {
  addRouteHook(routeDef, 'onRequest', (request, _reply, done) => {
    runGuards(
      chain,
      { kind: 'http', context: (request as FastifyRequest).httpContext as GuardContext, target },
      httpGuardDenial,
      done,
    )
  })
}
