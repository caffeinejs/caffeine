export interface ResponseConverter<T = unknown> {
  convert(response: Response): Promise<T>
}

/**
 * Default response converter: parses the body as JSON, treating an empty (204) response as
 * `undefined`.
 */
export const JsonResponseConverter: ResponseConverter = {
  async convert(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return undefined
    }

    return response.json()
  },
}

/**
 * Passes the raw {@link Response} through untouched.
 */
export const RawResponseConverter: ResponseConverter<Response> = {
  convert(response: Response): Promise<Response> {
    return Promise.resolve(response)
  },
}
