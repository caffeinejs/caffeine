import { ErrFetchyHTTP } from './errors.js'
import { isOk } from './http_response.js'
import type { ResponseConverter } from './response_converter.js'

export interface ResponseHandler {
  handle(request: Request, response: Response): Promise<Response>
}

/**
 * Passes successful responses through untouched; on a non-ok response, attempts to convert the
 * body (best-effort — parse failures fall back to `undefined`) and throws {@link ErrFetchyHTTP}.
 */
export class DefaultResponseHandler implements ResponseHandler {
  constructor(private readonly errorBodyConverter: ResponseConverter) {}

  async handle(request: Request, response: Response): Promise<Response> {
    if (isOk(response)) {
      return response
    }

    let body: unknown

    try {
      body = await this.errorBodyConverter.convert(response)
    } catch {
      body = undefined
    }

    throw new ErrFetchyHTTP(request, response, body)
  }
}

/**
 * Passes every response through untouched, including non-ok ones. Used for raw-response methods
 * that want to inspect the status themselves instead of relying on {@link ErrFetchyHTTP}.
 */
export const NoopResponseHandler: ResponseHandler = {
  handle(_request: Request, response: Response): Promise<Response> {
    return Promise.resolve(response)
  },
}
