import type { MethodSpec } from './decorators/registrar/index.js'
import { ErrFetchyMissingPathArgument } from './errors.js'
import { FetchyHeaders } from './headers.js'
import type { ParamDescriptor } from './internal/param_descriptor.js'
import { FetchyRequest } from './request.js'
import { JSONRequestBodyConverter, type RequestBodyConverter } from './request_body_converter.js'

const PLACEHOLDER = /\{(\w+)\}/g

// The labels `fetch` gives these bodies when nothing names a content-type. Applied here so that every transport
// sends the same header, undici included.
const TEXT_PLAIN_UTF8 = 'text/plain;charset=UTF-8'
const FORM_URL_ENCODED_UTF8 = 'application/x-www-form-urlencoded;charset=UTF-8'

// A parameter the compiled path does not already place. `key` is ready to use as is: a query key is encoded and
// carries its `=`, a header name is lowercased.
interface CompiledParam {
  kind: Exclude<ParamDescriptor['kind'], 'path'>
  key: string
  index: number
}

function compileParam(param: Exclude<ParamDescriptor, { kind: 'path' }>): CompiledParam {
  switch (param.kind) {
    case 'query':
      return { kind: param.kind, key: `${encodeURIComponent(param.key)}=`, index: param.index }
    case 'header':
      return { kind: param.kind, key: param.key.toLowerCase(), index: param.index }
    case 'form-field':
      return { kind: param.kind, key: param.key, index: param.index }
    default:
      return { kind: param.kind, key: '', index: param.index }
  }
}

function appendQueryEntry(query: string, key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return query
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      query += `${query === '' ? '?' : '&'}${key}${encodeURIComponent(String(element))}`
    }
    return query
  }

  return `${query}${query === '' ? '?' : '&'}${key}${encodeURIComponent(String(value))}`
}

/**
 * Builds a {@link FetchyRequest} from a method's metadata and its call arguments.
 *
 * @throws TypeError when `baseURL` is not empty and is not an absolute URL.
 */
export class RequestBuilder {
  // The path split around its placeholders: `segments[i]` precedes the argument at `slots[i]`, whose placeholder is
  // `slotKeys[i]`, and the last segment closes the path. A placeholder with no `@Param` stays in its segment as
  // written.
  private readonly segments: string[] = []
  private readonly slots: number[] = []
  private readonly slotKeys: string[] = []
  private readonly params: CompiledParam[] = []
  private readonly headers: Record<string, string> = {}
  private readonly bodyConverter: RequestBodyConverter
  private readonly origin: string = ''

  constructor(
    baseURL: string,
    private readonly meta: MethodSpec,
  ) {
    // A base URL's own path, as in `https://api.test/v1`, prefixes every method's path.
    let segment = ''
    let last = 0

    if (baseURL) {
      const url = new URL(baseURL)
      this.origin = url.origin
      segment = url.pathname === '/' ? '' : url.pathname
    }

    for (const match of meta.path.matchAll(PLACEHOLDER)) {
      segment += meta.path.slice(last, match.index)
      last = match.index + match[0].length

      const param = meta.params.find(p => p.kind === 'path' && p.key === match[1])

      if (param) {
        this.segments.push(segment)
        this.slots.push(param.index)
        this.slotKeys.push(match[1])
        segment = ''
      } else {
        segment += match[0]
      }
    }

    this.segments.push(segment + meta.path.slice(last))

    for (const param of meta.params) {
      if (param.kind !== 'path') {
        this.params.push(compileParam(param))
      }
    }

    for (const [name, value] of meta.headers) {
      this.headers[name] = value
    }

    this.bodyConverter = meta.requestBodyConverter ?? JSONRequestBodyConverter
  }

  /**
   * @throws {@link ErrFetchyMissingPathArgument} when a path parameter's argument is `undefined` or `null`.
   */
  toRequest(args: readonly unknown[]): FetchyRequest {
    let path = this.segments[0]

    for (let i = 0; i < this.slots.length; i++) {
      const value = args[this.slots[i]]

      if (value === undefined || value === null) {
        throw new ErrFetchyMissingPathArgument(this.meta.httpMethod, this.meta.path, this.slotKeys[i], value)
      }

      path += encodeURIComponent(String(value)) + this.segments[i + 1]
    }

    let query = ''
    const headers = new FetchyHeaders(this.headers)
    let formFields: URLSearchParams | undefined
    // `BodyInit` is a DOM-lib-only type name, unavailable in this package's `lib` set — `RequestInit`
    // (the standard Fetch API type) is available via `@types/node`'s ambient fetch globals, so its
    // own `body` member type is referenced directly here instead.
    let body: RequestInit['body'] = null
    let bodyValue: unknown
    let signal: AbortSignal | undefined

    for (const param of this.params) {
      const value = args[param.index]

      switch (param.kind) {
        case 'query':
          query = appendQueryEntry(query, param.key, value)
          break
        case 'query-name':
          if (value !== undefined && value !== null) {
            query += `${query === '' ? '?' : '&'}${encodeURIComponent(String(value))}`
          }
          break
        case 'header':
          if (value !== undefined && value !== null) {
            headers.append(param.key, String(value))
          }
          break
        case 'body':
          bodyValue = value
          body = this.bodyConverter.convert(value)
          break
        case 'form-field':
          formFields ??= new URLSearchParams()
          if (value !== undefined && value !== null) {
            formFields.append(param.key, String(value))
          }
          break
        case 'signal':
          signal = (value as AbortSignal | null | undefined) ?? undefined
          break
      }
    }

    if (formFields) {
      body = formFields.toString()
    }

    // Labelled after every argument is applied, so a content-type the declaration or an argument set wins wherever it
    // sits. Without a label a JSON-stringified body reaches the server as `text/plain`, which a strict one answers
    // with 415.
    if (body !== null && body !== undefined && !headers.has('content-type')) {
      const mediaType =
        (bodyValue === undefined ? undefined : this.bodyConverter.contentType?.(bodyValue)) ??
        (typeof body === 'string'
          ? TEXT_PLAIN_UTF8
          : body instanceof URLSearchParams
            ? FORM_URL_ENCODED_UTF8
            : undefined)

      if (mediaType !== undefined) {
        headers.set('content-type', mediaType)
      }
    }

    // undici cannot send a URLSearchParams, and fetch would only stringify it the same way.
    if (body instanceof URLSearchParams) {
      body = body.toString()
    }

    return new FetchyRequest(this.meta.httpMethod, this.origin, path + query, headers, body, signal)
  }
}
