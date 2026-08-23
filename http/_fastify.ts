import { type FastifyContext } from './context.js'
import { type CatchByMap } from './route.js'
import { type Principal } from './security/identity.js'

declare module 'fastify' {
  interface FastifyRequest {
    httpContext: FastifyContext
    responseCached: boolean
    controller: Record<string | symbol, unknown> | null
    user: Principal
  }

  interface FastifyContextConfig {
    caffeine?: {
      hasStatus: boolean
      status: number
      hasContentType: boolean
      contentType: string
      hasHeader: boolean
      header: Array<[string, string | string[]]>
      catchBy?: CatchByMap
    }
  }
}
