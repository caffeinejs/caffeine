import type { RunInfo } from '@caffeinejs/application'
import type { ConfigSnapshot, ConfigStore } from '@caffeinejs/application/config'
import type { Logger } from '@caffeinejs/application/logger'
import { errMessage } from '@caffeinejs/std/err'

import type { IAdapterTypes, IContextPlatform } from '../../adapter.js'
import { resolveAppURL } from '../../base_path.js'
import { ContextState, type IContext } from '../../context.js'
import type { InferBody, IRequest, UnsignedCookie } from '../../request.js'
import { ErrCookiesDisabled } from '../cookie/errors.js'
import type { CookieSerializeOptions } from '../cookie/options.js'
import type { CookieSecret, CookieUnsignResult } from '../cookie/signer.js'
import type { ProblemEncoder } from '../error/encode.js'
import type { GlobalErrorHandlerOptions } from '../error/error.js'
import type { ErrorHandlerProvider } from '../error/handler.js'
import { newProblem } from '../error/problem.js'
import { isThenable } from '../lifecycle/lifecycle.js'
import type { AuthenticationState } from '../security/auth/authentication_state.js'
import type { Principal } from '../security/identity.js'
import { isHopByHop, shapeAnswer } from './answer.js'
import { configurationError, sendProblem, USE_FASTIFY } from './error.js'
import type { SendPayload, ServerPlatform } from './platform.js'
import { parseQuery } from './query.js'
import type { ResolvedServerSettings } from './settings.js'

/** What every context of one server shares. Built once per server by `HTTPServer`. */
export interface ServerShared extends Pick<ResolvedServerSettings, 'application' | 'trustProxy' | 'requestIDHeader'> {
  readonly store: ConfigStore<unknown>
  readonly logger: Logger
  readonly errors: ErrorHandlerProvider
  readonly options: Required<GlobalErrorHandlerOptions>
  readonly encodeProblem: ProblemEncoder
}

/** What a context of the engine is typed with on every platform: `ctx.req.raw` is a `Request`. */
export interface EngineContextTypes extends IAdapterTypes {
  instance: unknown
  request: unknown
  extension: never
  hook: never
  raw: Request
  cookieOptions: CookieSerializeOptions
  asyncCookies: true
  platform: IContextPlatform
  serverOptions: object
  runArgs: readonly unknown[]
  runInfo: RunInfo
}

type Params = Readonly<Record<string, string | undefined>>

/**
 * The {@link IContext} the engine builds for every request. Also what routes compile against, and what a group's
 * `onRequest` hook is handed as both its request and its reply.
 */
export class Context implements IContext<Record<never, never>, Record<never, never>, EngineContextTypes> {
  /** @see {@link IContext.auth} */
  auth?: AuthenticationState

  /** `null` until authentication writes it, as on Fastify. */
  user: Principal = null as unknown as Principal

  /** The controller instance a decorated group's `onRequest` resolved. */
  routeTarget: Record<string | symbol, (...args: unknown[]) => unknown> | null = null

  readonly #shared: ServerShared
  readonly #platform: ServerPlatform<unknown, IContextPlatform, unknown>
  readonly #native: unknown
  readonly #extra: unknown
  readonly #id: number
  readonly #method: string
  readonly #url: string
  readonly #basePath: string
  readonly #params: Params
  readonly #query: string

  #req?: ContextRequest
  #context?: IContextPlatform
  #state?: ContextState
  #config?: ConfigSnapshot<Record<never, never>>

  #status = 200
  readonly #headers: Record<string, string | string[]> = Object.create(null)
  #payload: SendPayload | undefined
  #answered = false
  #responded = false
  #expired = false
  #onAnswered: (() => void) | undefined
  #connectionFields = false

  #signal?: AbortController
  #abortReason?: Error

  constructor(
    shared: ServerShared,
    platform: ServerPlatform<unknown, IContextPlatform, unknown>,
    native: unknown,
    extra: unknown,
    id: number,
    method: string,
    url: string,
    basePath: string,
    params: Params,
    query: string,
  ) {
    this.#shared = shared
    this.#platform = platform
    this.#native = native
    this.#extra = extra
    this.#id = id
    this.#method = method
    this.#url = url
    this.#basePath = basePath
    this.#params = params
    this.#query = query
  }

  get req(): ContextRequest {
    return (this.#req ??= new ContextRequest(
      this.#shared,
      this.#platform,
      this.#native,
      this.#id,
      this.#method,
      this.#url,
      this.#basePath,
      this.#params,
      this.#query,
    ))
  }

  /** Where the request came from. See {@link IContext.platform}. */
  get platform(): IContextPlatform {
    return (this.#context ??= this.#platform.context(this.#native, this.#extra))
  }

  get state(): ContextState {
    return (this.#state ??= new ContextState())
  }

  /** The application configuration, as the snapshot current the first time this reads. */
  get config(): ConfigSnapshot<Record<never, never>> {
    return (this.#config ??= this.#shared.store.current as ConfigSnapshot<Record<never, never>>)
  }

  /** This context, for a custom pick written as `req => req.httpContext…`. */
  get httpContext(): this {
    return this
  }

  /** Whether a header that describes the connection was set, which the engine drops before sending. */
  get hasConnectionFields(): boolean {
    return this.#connectionFields
  }

  /** Where the request came from, as the runtime says: `127.0.0.1` for `request()`, `undefined` when it says nothing. */
  get remoteAddress(): string | undefined {
    return this.#platform.remoteAddress(this.#native)
  }

  get statusCode(): number {
    return this.#status
  }

  /** @see {@link IContext.sent} */
  get sent(): boolean {
    return this.#answered
  }

  /** What the route declared lives on the route itself; there is no adapter config to hand out. */
  get routeConfig(): unknown {
    return undefined
  }

  /** See {@link IContext.signal}. Aborts when the client leaves and when the request's timeout fires. */
  get signal(): AbortSignal {
    if (this.#signal === undefined) {
      const controller = new AbortController()
      this.#signal = controller

      if (this.#abortReason !== undefined) {
        controller.abort(this.#abortReason)
      } else {
        const client = this.#platform.signal(this.#native)

        if (client.aborted) {
          controller.abort(client.reason)
        } else {
          client.addEventListener('abort', () => controller.abort(client.reason), { once: true })
        }
      }
    }

    return this.#signal.signal
  }

  /**
   * Sets the status.
   *
   * @throws ErrConfiguration for anything but an integer from 200 to 599.
   */
  status(code: number): this {
    if (this.#late('status')) {
      return this
    }

    if (!Number.isInteger(code) || code < 200 || code > 599) {
      throw configurationError(
        `Cannot set status "${code}": the ${this.#shared.application} sends a status from 200 to 599`,
        'Pass an HTTP status such as 200, 404 or 503',
      )
    }

    this.#status = code
    return this
  }

  header(key: string, value: string): this {
    if (this.#late('header')) {
      return this
    }

    const name = key.toLowerCase()

    // A cookie is a value of its own, never a replacement for another, as Fastify's `reply.header` treats it.
    if (name === 'set-cookie' && this.#headers[name] !== undefined) {
      return this.#append(name, value)
    }

    if (isHopByHop(name)) {
      this.#connectionFields = true
    }

    this.#headers[name] = value
    return this
  }

  appendHeader(key: string, value: string): this {
    if (this.#late('appendHeader')) {
      return this
    }

    return this.#append(key.toLowerCase(), value)
  }

  headers(headers: Record<string, string>): this {
    for (const [key, value] of Object.entries(headers)) {
      this.header(key, value)
    }

    return this
  }

  hasHeader(key: string): boolean {
    return this.#headers[key.toLowerCase()] !== undefined
  }

  getHeader(key: string): string | undefined {
    const value = this.#headers[key.toLowerCase()]
    return Array.isArray(value) ? value.join(', ') : value
  }

  cookie(_name: string, _value: string, _opts?: CookieSerializeOptions): this {
    throw cookiesDisabled('set cookies', this.#shared.application)
  }

  deleteCookie(_name: string, _opts?: CookieSerializeOptions): this {
    throw cookiesDisabled('delete cookies', this.#shared.application)
  }

  body(body?: unknown): this {
    return this.#send('body', body)
  }

  badRequest(body?: unknown): this {
    return this.#fail(400, 'ERR_HTTP_BAD_REQUEST', 'badRequest', body)
  }

  notFound(body?: unknown): this {
    return this.#fail(404, 'ERR_HTTP_NOT_FOUND', 'notFound', body)
  }

  unprocessableContent(body?: unknown): this {
    return this.#fail(422, 'ERR_HTTP_UNPROCESSABLE_CONTENT', 'unprocessableContent', body)
  }

  internalServerError(body?: unknown): this {
    return this.#fail(500, 'ERR_HTTP_INTERNAL_SERVER_ERROR', 'internalServerError', body)
  }

  redirect(url: string, status = 302): this {
    if (this.#alreadyAnswered()) {
      return this
    }

    this.status(status)
    this.header('location', resolveAppURL(url, this.#basePath))
    this.#payload = null
    this.#markAnswered()
    return this
  }

  /** The server's logger, for what the engine reports about this request. */
  get logger(): Logger {
    return this.#shared.logger
  }

  /** What goes out as the body: `undefined` until the request is answered. */
  get payload(): SendPayload | undefined {
    return this.#payload
  }

  /** The response headers written so far, by lower-case name. */
  get responseHeaders(): Record<string, string | string[]> {
    return this.#headers
  }

  /** Whether the answer has been handed to the platform. */
  get responded(): boolean {
    return this.#responded
  }

  markResponded(): void {
    this.#responded = true
  }

  /** Answers with `body` under `status`, which stands over a `Response`'s own: an error's body. */
  answerWithStatus(body: unknown, status: number): this {
    return this.#send('body', body, status)
  }

  /** Whether the request's timeout fired: what its handler settles with later is dropped. */
  get expired(): boolean {
    return this.#expired
  }

  /** Marks the timeout fired. */
  expire(): void {
    this.#expired = true
  }

  /** Calls `callback` once the request is answered, at once if it already is. */
  onAnswered(callback: () => void): void {
    if (this.#answered) {
      callback()
    } else {
      this.#onAnswered = callback
    }
  }

  /** Aborts {@link signal} with `reason`, now or when it is first read. */
  abort(reason: Error): void {
    if (this.#signal === undefined) {
      this.#abortReason ??= reason
    } else if (!this.#signal.signal.aborted) {
      this.#signal.abort(reason)
    }
  }

  #append(name: string, value: string): this {
    if (isHopByHop(name)) {
      this.#connectionFields = true
    }

    const current = this.#headers[name]

    if (current === undefined) {
      this.#headers[name] = value
    } else if (Array.isArray(current)) {
      current.push(value)
    } else {
      this.#headers[name] = [current, value]
    }

    return this
  }

  #markAnswered(): void {
    this.#answered = true
    const callback = this.#onAnswered
    this.#onAnswered = undefined
    callback?.()
  }

  // A write once the request is answered cannot reach the answer: it is final at `ctx.body`, as on Fastify.
  #late(method: string): boolean {
    if (!this.#answered) {
      return false
    }

    this.#shared.logger.warn({ reqId: this.req.id, method }, 'Cannot change the response once it is sent: ignoring')
    return true
  }

  #alreadyAnswered(): boolean {
    if (!this.#answered) {
      return false
    }

    this.#shared.logger.warn(
      { reqId: this.req.id },
      'Cannot answer a request already answered: dropping the late answer',
    )
    return true
  }

  /**
   * Sends an error status, defaulting the body to the same problem a thrown `ErrHTTP` renders to, under the same
   * media type. A body given is sent as it stands.
   */
  #fail(statusCode: number, code: string, method: string, body?: unknown): this {
    // `#send` refuses a late answer, with the one warning.
    if (body !== undefined || this.#answered) {
      return this.#send(method, body, statusCode)
    }

    sendProblem(this.#shared, this, newProblem({ status: statusCode, code }))
    return this
  }

  /** Answers with `body`, under `statusCode` when given, which stands over a Response's own. */
  #send(method: string, body: unknown, statusCode?: number): this {
    // Refused before anything is written: a promise would go out as `{}`. The context stays unanswered, so the
    // handler can still answer with what it resolves to.
    if (isThenable(body)) {
      throw configurationError(
        `Cannot send a promise with ctx.${method}(...): it would go out as {}`,
        `Await it first: ctx.${method}(await value)`,
        ...(method === 'body' ? ['Return the promise from the handler instead: the route waits for it'] : []),
      )
    }

    if (this.#alreadyAnswered()) {
      return this
    }

    // Shaped first: an answer that cannot be sent at all throws with nothing written, and the context stays
    // unanswered for a catch handler to answer instead.
    const payload = shapeAnswer(this, body, statusCode !== undefined)

    if (statusCode !== undefined) {
      this.status(statusCode)
    }

    this.#payload = payload
    this.#markAnswered()
    return this
  }
}

/** What a request handler reads of the request the engine is serving. */
export class ContextRequest implements IRequest<
  Request,
  Record<string, string>,
  Record<string, string>,
  Record<string, string>,
  true,
  unknown
> {
  readonly #shared: ServerShared
  readonly #platform: ServerPlatform<unknown, IContextPlatform, unknown>
  readonly #native: unknown
  readonly #id: number
  readonly #method: string
  readonly #url: string
  readonly #basePath: string
  readonly #params: Params
  readonly #query: string

  #parsedQuery?: Record<string, string | string[]>
  #headers?: Record<string, string>
  #requestID?: string
  #trusted?: boolean
  #raw?: Request

  constructor(
    shared: ServerShared,
    platform: ServerPlatform<unknown, IContextPlatform, unknown>,
    native: unknown,
    id: number,
    method: string,
    url: string,
    basePath: string,
    params: Params,
    query: string,
  ) {
    this.#shared = shared
    this.#platform = platform
    this.#native = native
    this.#id = id
    this.#method = method
    this.#url = url
    this.#basePath = basePath
    this.#params = params
    this.#query = query
  }

  get raw(): Request {
    return (this.#raw ??= this.#platform.request(this.#native))
  }

  /** The value of the server's `requestIDHeader` when the request carries one, else a number in Fastify's form. */
  get id(): string {
    if (this.#requestID === undefined) {
      const name = this.#shared.requestIDHeader
      const given = name === undefined ? undefined : this.#platform.header(this.#native, name)

      // Fastify's default form, so log lines read the same on either server.
      this.#requestID = given === undefined || given === '' ? `req-${this.#id.toString(36)}` : given
    }

    return this.#requestID
  }

  get url(): string {
    return this.#url
  }

  get basePath(): string {
    return this.#basePath
  }

  get method(): string {
    return this.#method
  }

  /** `X-Forwarded-Host` from a trusted proxy, else the `Host` header, else the host of the request's URL. */
  get host(): string {
    return (
      this.#forwarded('x-forwarded-host') ?? this.#platform.header(this.#native, 'host') ?? new URL(this.raw.url).host
    )
  }

  /** `X-Forwarded-Proto` from a trusted proxy, lower-cased, else the scheme of the connection. */
  get protocol(): string {
    return this.#forwarded('x-forwarded-proto')?.toLowerCase() ?? this.#platform.protocol(this.#native)
  }

  /** @throws ErrConfiguration: the engine reads no request body yet. */
  body(): InferBody<Record<never, never>> {
    throw configurationError(`Cannot read the request body on the ${this.#shared.application} yet`, USE_FASTIFY)
  }

  query(): Record<string, string>
  query(key: string): string | undefined
  query(key?: string): Record<string, string> | string | undefined {
    const query = (this.#parsedQuery ??= parseQuery(this.#query))

    // A repeated key reads back as its list, as on Fastify: the declared type is the single-value one.
    return key === undefined ? (query as Record<string, string>) : (query[key] as string | undefined)
  }

  queries(key: string): string[] | undefined {
    const value = (this.#parsedQuery ??= parseQuery(this.#query))[key]

    if (Array.isArray(value)) {
      return value
    }

    return value === undefined ? undefined : [value]
  }

  header(): Record<string, string>
  header(key: string): string | undefined
  header(key?: string): Record<string, string> | string | undefined {
    if (key === undefined) {
      return (this.#headers ??= this.#platform.headers(this.#native))
    }

    return this.#platform.header(this.#native, key)
  }

  hasHeader(key: string): boolean {
    return this.#platform.header(this.#native, key) !== undefined
  }

  param(): Record<string, string>
  param(key: string): string | undefined
  param(key?: string): Record<string, string> | string | undefined {
    return key === undefined ? (this.#params as Record<string, string>) : this.#params[key]
  }

  cookie(): Record<string, string>
  cookie(name: string): string | undefined
  cookie(_name?: string): never {
    throw cookiesDisabled('read cookies', this.#shared.application)
  }

  signedCookie(): Promise<Record<string, UnsignedCookie>>
  signedCookie(name: string, secret?: CookieSecret): Promise<UnsignedCookie>
  signedCookie(_name?: string, _secret?: CookieSecret): never {
    throw cookiesDisabled('read cookies', this.#shared.application)
  }

  unsignCookie(_value: string, _secret?: CookieSecret): Promise<CookieUnsignResult> {
    throw cookiesDisabled('unsign a cookie', this.#shared.application)
  }

  // The last entry of a forwarding header, read only when the peer is a proxy the server trusts.
  #forwarded(name: string): string | undefined {
    const trust = this.#shared.trustProxy
    if (trust === undefined) {
      return undefined
    }

    const value = this.#platform.header(this.#native, name)
    if (value === undefined) {
      return undefined
    }

    // Judged once per request: `host` and `protocol` ask about the same peer.
    if (!(this.#trusted ??= trust(this.#platform.remoteAddress(this.#native)))) {
      return undefined
    }

    const last = value.slice(value.lastIndexOf(',') + 1).trim()
    return last === '' ? undefined : last
  }
}

function cookiesDisabled(action: string, application: string): ErrCookiesDisabled {
  return new ErrCookiesDisabled(
    errMessage(`Cannot ${action}: the ${application} handles no cookies yet`)
      .solutions(`${USE_FASTIFY} to use cookies`)
      .reference('@caffeinejs/http', ErrCookiesDisabled)
      .build(),
  )
}
