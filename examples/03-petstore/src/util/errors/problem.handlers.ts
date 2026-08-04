import { Catch, type Context, ErrHTTP, ErrorHandler } from '@caffeinejs/http'
import { instanceOf, problemFor, sendProblem, type ProblemError } from './problem.js'

// Shape of a Fastify schema-validation failure. Fastify attaches `validation` (the Ajv errors) and
// `validationContext` (which part of the request failed) to the thrown error.
interface ValidationError extends Error {
  validation: Array<{
    instancePath?: string
    keyword?: string
    message?: string
    params?: { missingProperty?: string }
  }>
  validationContext?: 'body' | 'params' | 'querystring' | 'headers'
}

function isValidationError(err: Error): err is ValidationError {
  return Array.isArray((err as Partial<ValidationError>).validation)
}

function toProblemErrors(err: ValidationError): ProblemError[] {
  return err.validation.map(v => {
    const field = v.instancePath
      ? v.instancePath.replace(/^\//, '').replace(/\//g, '.')
      : v.params?.missingProperty ?? ''

    return {
      field,
      message: v.message ?? 'Invalid value',
      ...(v.keyword !== undefined ? { code: v.keyword } : {}),
    }
  })
}

// Renders any thrown ErrHTTP (e.g. ErrNotFound → 404) as RFC 9457 problem+json.
@Catch(ErrHTTP)
export class HTTPProblemHandler extends ErrorHandler<ErrHTTP> {
  async handle(ctx: Context, err: ErrHTTP): Promise<void> {
    sendProblem(ctx, problemFor(err.statusCode, err.message, { instance: instanceOf(ctx) }))
  }
}

// Catch-all: schema-validation failures become 400 (params/query) or 422 (body, with field errors);
// anything else is an unexpected 500.
@Catch(Error)
export class FallbackProblemHandler extends ErrorHandler<Error> {
  async handle(ctx: Context, err: Error): Promise<void> {
    const instance = instanceOf(ctx)

    if (isValidationError(err)) {
      if (err.validationContext === 'body') {
        sendProblem(ctx, problemFor(422, 'The request body contains validation errors', {
          instance,
          errors: toProblemErrors(err),
        }))
        return
      }

      sendProblem(ctx, problemFor(400, 'The request contains invalid parameters', { instance }))
      return
    }

    console.error('Unhandled error while processing request:', err)
    sendProblem(ctx, problemFor(500, 'An unexpected error occurred. Please try again later', { instance }))
  }
}
