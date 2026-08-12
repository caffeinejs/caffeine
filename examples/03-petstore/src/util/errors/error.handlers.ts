import { Catch, type Context, ErrHTTP, ErrorHandler } from '@caffeinejs/http'

// A simple, conventional error body: a machine-readable `code`, a human-readable `message`, and —
// for validation failures — a list of the offending fields. Rendered as plain application/json.
export interface ErrorBody {
  code: string
  message: string
  errors?: FieldError[]
}

export interface FieldError {
  field: string
  message: string
}

// HTTP status → short, stable error code. Anything not listed falls back to a generic 'ERROR'.
const CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
}

function codeFor(status: number): string {
  return CODES[status] ?? 'ERROR'
}

// Shape of a Fastify schema-validation failure. Fastify attaches `validation` (the Ajv errors) and
// `validationContext` (which part of the request failed) to the thrown error.
interface ValidationError extends Error {
  validation: Array<{
    instancePath?: string
    message?: string
    params?: { missingProperty?: string }
  }>
  validationContext?: 'body' | 'params' | 'querystring' | 'headers'
}

function isValidationError(err: Error): err is ValidationError {
  return Array.isArray((err as Partial<ValidationError>).validation)
}

function fieldErrors(err: ValidationError): FieldError[] {
  return err.validation.map(v => ({
    field: v.instancePath
      ? v.instancePath.replace(/^\//, '').replace(/\//g, '.')
      : v.params?.missingProperty ?? '',
    message: v.message ?? 'Invalid value',
  }))
}

// Renders any thrown ErrHTTP (e.g. ErrHTTPNotFound → 404) as { code, message }.
@Catch(ErrHTTP)
export class HTTPErrorHandler extends ErrorHandler<ErrHTTP> {
  async handle(ctx: Context, err: ErrHTTP): Promise<void> {
    ctx.status(err.statusCode).body({ code: codeFor(err.statusCode), message: err.message })
  }
}

// Catch-all: schema-validation failures become 422 (body, with field errors) or 400 (params/query);
// anything else is an unexpected 500.
@Catch(Error)
export class FallbackErrorHandler extends ErrorHandler<Error> {
  async handle(ctx: Context, err: Error): Promise<void> {
    if (isValidationError(err)) {
      if (err.validationContext === 'body') {
        ctx.status(422).body({
          code: 'VALIDATION_ERROR',
          message: 'The request body is invalid',
          errors: fieldErrors(err),
        })
        return
      }

      ctx.status(400).body({ code: 'BAD_REQUEST', message: 'The request contains invalid parameters' })
      return
    }

    console.error('Unhandled error while processing request:', err)
    ctx.status(500).body({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred. Please try again later' })
  }
}
