import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Adds the constraint headers to `Vary` on every response, when any registered route selects on a header.
 *
 * A versioned route and its unversioned twin share a URL, so a cache keyed on the URL alone would serve one
 * client the other's representation. Fastify documents this; the header list is framework-owned rather than
 * left to each route. With no constrained route the hook returns before touching the reply.
 */
const constraintVaryPluginFn: FastifyPluginAsync = async instance => {
  const headers = new Set<string>()
  let owned: readonly string[] = []

  instance.addHook('onRoute', options => {
    const constraints = options.config?.$caffeine?.route.constraints
    if (constraints === undefined) {
      return
    }

    for (const resolved of constraints.values()) {
      if (resolved.header) {
        headers.add(resolved.header)
      }
    }
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
