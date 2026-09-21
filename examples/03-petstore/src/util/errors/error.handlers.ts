import { HTML } from '@caffeinejs/html'
import { Catch, type ActionResult, type Context, ErrHTTP, ErrorHandler } from '@caffeinejs/http'
import { $t } from '@caffeinejs/std'

import { ErrorPage } from './html/ErrorPage.js'

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

// The same body as a schema, so the OpenAPI document describes what these handlers actually return. The `$id`
// is what lands it in components.schemas as `ApiError` and turns every use into a $ref.
export const FieldErrorSchema = $t.Object(
  {
    field: $t.String(),
    message: $t.String(),
  },
  { $id: 'FieldError' },
)

export const APIErrorSchema = $t.Object(
  {
    code: $t.String(),
    message: $t.String(),
    errors: $t.Optional($t.Array(FieldErrorSchema)),
  },
  { $id: 'ApiError' },
)

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

// Browser requests (Accept: text/html) get an HTML error page; API clients get JSON. Content negotiation
// lives here in the app, not the framework — the framework just renders whatever the handler returns.
function wantsHTML(ctx: Context): boolean {
  return ctx.req.header('accept')?.includes('text/html') ?? false
}

// Returns the JSON body, or a rendered error page when the client asked for HTML. `ctx.status(...)` sets
// the response code either way; the returned value is finalized by the framework (JSON or HTML).
function respond(ctx: Context, status: number, body: ErrorBody): ErrorBody | ReturnType<typeof HTML> {
  ctx.status(status)
  return wantsHTML(ctx) ? HTML(ErrorPage({ ...body, status })) : body
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
    field: v.instancePath ? v.instancePath.replace(/^\//, '').replace(/\//g, '.') : (v.params?.missingProperty ?? ''),
    message: v.message ?? 'Invalid value',
  }))
}

// Renders any thrown ErrHTTP (e.g. ErrHTTPNotFound → 404) as { code, message } — JSON, or an HTML error
// page for browser requests.
@Catch(ErrHTTP)
export class HTTPErrorHandler implements ErrorHandler<ErrHTTP> {
  async handle(ctx: Context, err: ErrHTTP): Promise<ActionResult> {
    return respond(ctx, err.statusCode, {
      code: codeFor(err.statusCode),
      message: err.message,
    })
  }
}

// Catch-all: schema-validation failures become 422 (body, with field errors) or 400 (params/query);
// anything else is an unexpected 500.
@Catch(Error)
export class FallbackErrorHandler implements ErrorHandler<Error> {
  async handle(ctx: Context, err: Error): Promise<ActionResult> {
    if (isValidationError(err)) {
      if (err.validationContext === 'body') {
        return respond(ctx, 422, {
          code: 'VALIDATION_ERROR',
          message: 'The request body is invalid',
          errors: fieldErrors(err),
        })
      }

      return respond(ctx, 400, {
        code: 'BAD_REQUEST',
        message: 'The request contains invalid parameters',
      })
    }

    console.error('Unhandled error while processing request:', err)

    return respond(ctx, 500, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again later',
    })
  }
}
