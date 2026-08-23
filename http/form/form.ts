import type { FastifyRequest } from 'fastify'
import qs from 'fast-querystring'
import { FeatureConfigurer, type ServerPhaseContext } from '../feature_configurer.js'
import { MediaType } from '../media.js'

const FORM_BODY_LIMIT = 1_048_576

/**
 * Registers the `application/x-www-form-urlencoded` body parser.
 * Parses the body into a plain object.
 */
export class FormBodyConfigurer extends FeatureConfigurer {
  readonly name = 'form-body'

  configureServer(ctx: ServerPhaseContext): void {
    ctx.server.addContentTypeParser(
      MediaType.APPLICATION_FORM_URLENCODED,
      { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT },
      formBodyParser,
    )
  }
}

function formBodyParser(
  _req: FastifyRequest,
  body: string,
  done: (err: Error | null, value?: unknown) => void,
): void {
  try {
    done(null, qs.parse(body))
  } catch (err) {
    (err as { statusCode?: number }).statusCode = 400
    done(err as Error)
  }
}
