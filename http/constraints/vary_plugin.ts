import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

import { ErrConfiguration } from '../error/index.js'
import { solutions } from '../error/util.js'
import { kRouteConstraints, type ResolvedRouteConstraint } from './plugin.js'

/**
 * Resolves every route's declared constraints into Fastify's own `constraints` matching object, and adds their
 * headers to `Vary` on every response, when any registered route selects on one.
 *
 * `constraint()` / `version()` write into `route.config` rather than a dedicated compiled field, so this is
 * where that declaration turns into what find-my-way actually matches on — mutating `routeOptions.constraints`
 * from `onRoute` is a route taking the hooks in place when it registers, same as any other Fastify plugin.
 * Fails when a name is set both here and through `fst({ constraints })`, rather than silently disagreeing.
 *
 * A versioned route and its unversioned twin share a URL, so a cache keyed on the URL alone would serve one
 * client the other's representation. Fastify documents this; the header list is framework-owned rather than
 * left to each route. With no constrained route the `onSend` hook returns before touching the reply.
 */
const constraintVaryPluginFn: FastifyPluginAsync = async instance => {
  const headers = new Set<string>()
  let owned: readonly string[] = []

  instance.addHook('onRoute', options => {
    const config = options.config as Record<string, unknown> | undefined
    const declared = config?.[kRouteConstraints] as Map<string, ResolvedRouteConstraint> | undefined
    if (declared === undefined || declared.size === 0) {
      return
    }

    const existing = options.constraints as Record<string, unknown> | undefined
    const constraints: Record<string, unknown> = { ...existing }

    for (const [name, resolved] of declared) {
      if (existing !== undefined && name in existing) {
        throw new ErrConfiguration(
          `Cannot register "${options.method} ${options.url}": constraint "${name}" is set by both ` +
            `"fst({ constraints })" and "@Constraint" or "constraint()"` +
            solutions(`Remove "${name}" from the "fst({ constraints })" call`, 'Declare each constraint one way only'),
        )
      }

      constraints[name] = resolved.value
      if (resolved.header !== undefined) {
        headers.add(resolved.header)
      }
    }

    options.constraints = constraints
  })

  instance.addHook('onReady', async () => {
    owned = [...headers]
  })

  // Added now, not once the headers are known: a route takes the hooks in place when it registers.
  instance.addHook('onSend', (_request, reply, payload, done) => {
    if (owned.length === 0) {
      done(null, payload)
      return
    }

    appendVary(reply, owned)
    done(null, payload)
  })
}

export const constraintVaryPlugin = fp(constraintVaryPluginFn, { name: 'caffeine-constraint-vary' })

function appendVary(reply: FastifyReply, owned: readonly string[]): void {
  const current = reply.getHeader('vary')
  const existing =
    typeof current === 'string'
      ? current
          .split(',')
          .map(token => token.trim())
          .filter(Boolean)
      : []

  if (existing.includes('*')) {
    return
  }

  const merged = [...new Set([...existing, ...owned])]
  reply.header('vary', merged.join(', '))
}
