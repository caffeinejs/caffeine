import { kExtensionStage, type ExtensionStage } from '@caffeinejs/std'
import type { FastifyReply } from 'fastify'

import { ServerExtension, type ServerExtensionContext } from '../server_extension.js'

/**
 * Adds the constraint headers to `Vary` on every response, when any registered route selects on a header.
 *
 * A versioned route and its unversioned twin share a URL, so a cache keyed on the URL alone would serve one
 * client the other's representation. Fastify documents this; the header list is framework-owned rather than
 * left to each route. No constrained route means no hook and no cost.
 *
 * `core`, so the hook is in place before any route registers.
 */
export class ConstraintVaryExtension extends ServerExtension {
  readonly name = 'caffeine-constraint-vary'
  readonly [kExtensionStage]: ExtensionStage = 'core'

  configure(ctx: ServerExtensionContext): void {
    const headers = new Set<string>()
    for (const group of ctx.routeGroups) {
      for (const route of group.routes) {
        if (!route.constraints) {
          continue
        }
        for (const resolved of route.constraints.values()) {
          if (resolved.header) {
            headers.add(resolved.header)
          }
        }
      }
    }

    if (headers.size === 0) {
      return
    }

    const owned = [...headers]
    ctx.server.addHook('onSend', (_request, reply, payload, done) => {
      appendVary(reply, owned)
      done(null, payload)
    })
  }
}

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
