import { pathParamPattern } from './internal/path_util.js'
import type { MethodMeta } from './metadata.js'
import { JsonRequestBodyConverter } from './request_body_converter.js'

function appendQueryEntry(query: string[], key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(element))}`)
    }
    return
  }

  query.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
}

/**
 * Builds a native {@link Request} from a method's metadata and its call arguments.
 */
export class RequestBuilder {
  constructor(
    private readonly baseUrl: string,
    private readonly meta: MethodMeta,
  ) {}

  toRequest(args: readonly unknown[]): Request {
    let path = this.meta.path
    const query: string[] = []
    const headers = new Headers(this.meta.headers)
    let formFields: URLSearchParams | undefined
    // `BodyInit` is a DOM-lib-only type name, unavailable in this package's `lib` set — `RequestInit`
    // (the standard Fetch API type) is available via `@types/node`'s ambient fetch globals, so its
    // own `body` member type is referenced directly here instead.
    let body: RequestInit['body'] = null
    let signal: AbortSignal | null = null

    for (const param of this.meta.params) {
      const value = args[param.index]

      switch (param.kind) {
        case 'path':
          path = path.replace(pathParamPattern(param.key), encodeURIComponent(String(value)))
          break
        case 'query':
          appendQueryEntry(query, param.key, value)
          break
        case 'query-name':
          if (value !== undefined && value !== null) {
            query.push(encodeURIComponent(String(value)))
          }
          break
        case 'header':
          if (value !== undefined && value !== null) {
            headers.append(param.key, String(value))
          }
          break
        case 'body':
          body = JsonRequestBodyConverter.convert(value)
          break
        case 'form-field':
          formFields ??= new URLSearchParams()
          if (value !== undefined && value !== null) {
            formFields.append(param.key, String(value))
          }
          break
        case 'signal':
          signal = value as AbortSignal
          break
      }
    }

    if (formFields) {
      body = formFields.toString()
    }

    const queryString = query.length > 0 ? `?${query.join('&')}` : ''
    const input: RequestInit = {
      method: this.meta.httpMethod,
      headers,
      body,
    }

    if (signal) {
      input.signal = signal
    }

    const url = `${this.baseUrl}${path}${queryString}`

    return new Request(url, input)
  }
}
