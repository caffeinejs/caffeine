import type { FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

import type { HTTPPlugin } from '../plugin.js'

/**
 * Adds the constraint headers to `Vary` on every response, when any registered route selects on a header.
 *
 * A versioned route and its unversioned twin share a URL, so a cache keyed on the URL alone would serve one
 * client the other's representation. Fastify documents this; the header list is framework-owned rather than
 * left to each route. No constrained route means no hook and no cost.
 */
const constraintVaryPluginFn: HTTPPlugin = async (instance, { routeGroups }) => {
  const headers = new Set<string>()
  for (const group of routeGroups) {
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
  instance.addHook('onSend', (_request, reply, payload, done) => {
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
