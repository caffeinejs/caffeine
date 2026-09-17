declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the cache read hook once it has served (or 304'd) from the store, so the store hook skips. */
    responseCached: boolean
  }
}

export {}
