import { isValidKey, type InjectionToken } from '@caffeinejs/di'
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify'
import fp from 'fastify-plugin'

import { solutions } from '../error/util.js'
import {
  assertWritable,
  cookieDefaults,
  describeCookie,
  parseCookies,
  prepareCookie,
  serializeCookie,
  type CookieOperation,
  type PreparedCookie,
} from './_serialize.js'
import { ErrCookieConfiguration, ErrCookiesDisabled, ErrCookieTooLate } from './errors.js'
import type { CookieParseOptions, CookieSerializeOptions } from './options.js'
import { CookieSigner, HMACCookieSigner, secretList, type CookieSecret, type CookieSigningAlgorithm } from './signer.js'

/** What the cookie plugin of one server runs on. */
export interface CookiePluginOptions {
  /** Off leaves the plugin unregistered: reading or setting a cookie then throws `ErrCookiesDisabled`. */
  enabled: boolean
  signer?: CookieSigner | InjectionToken<CookieSigner>
  /** Builds the HMAC signer. Refused together with {@link signer}. */
  secret?: CookieSecret
  algorithm?: CookieSigningAlgorithm
  parseOptions?: CookieParseOptions
}

const kServerCookies = Symbol('caffeine.http.cookies')
const kPendingCookies = Symbol('caffeine.http.cookies.pending')
const kCookieFlush = Symbol('caffeine.http.cookies.flush')

/**
 * Where a reply's cookies stand. `undefined` on a reply the plugin never decorated: one of a route whose context was
 * created before the plugin registered, which runs none of its hooks.
 */
type FlushState = 'open' | 'done' | 'failed' | undefined

interface PendingCookie {
  readonly op: CookieOperation
  readonly prepared: PreparedCookie
  readonly value: string
  /** The `Set-Cookie` line, or `undefined` until the value is signed. */
  line: string | undefined
}

interface CookieReply {
  [kPendingCookies]: Map<string, PendingCookie> | null
  [kCookieFlush]: FlushState
}

interface CookieInstance {
  [kServerCookies]?: ServerCookies
}

/** One server's cookies: its signer and defaults, settled when the plugin registered. */
export class ServerCookies {
  readonly #signer: CookieSigner
  readonly #signsByDefault: boolean
  readonly #defaults: CookieSerializeOptions
  readonly #decode: ((value: string) => string | undefined) | undefined

  constructor(signer: CookieSigner, signsByDefault: boolean, parseOptions: CookieParseOptions | undefined) {
    const { defaults, decode } = cookieDefaults(parseOptions)

    this.#signer = signer
    this.#signsByDefault = signsByDefault
    this.#defaults = defaults
    this.#decode = decode
  }

  /** The cookies `request` carries. */
  parse(request: FastifyRequest): Record<string, string> {
    return parseCookies(request.headers.cookie, this.#decode)
  }

  /**
   * The value `signed` carries, or `false` when it does not verify: with `secret` when one is given, otherwise with
   * the server's signer.
   *
   * @throws ErrCookieConfiguration when there is nothing to verify with.
   */
  async verify(signed: string, secret: CookieSecret | undefined): Promise<string | false> {
    const result = await this.#signer.unsign(signed, secret)

    return result.valid ? result.value : false
  }

  set(request: FastifyRequest, reply: FastifyReply, name: string, value: string, options?: CookieSerializeOptions) {
    this.#queue('set', request, reply, name, value, options)
  }

  delete(request: FastifyRequest, reply: FastifyReply, name: string, options?: CookieSerializeOptions) {
    this.#queue('delete', request, reply, name, '', options)
  }

  #queue(
    op: CookieOperation,
    request: FastifyRequest,
    reply: FastifyReply,
    name: string,
    value: string,
    options: CookieSerializeOptions | undefined,
  ): void {
    const cookieReply = reply as unknown as CookieReply
    const state = cookieReply[kCookieFlush]

    if (state === undefined) {
      throw new ErrCookiesDisabled(
        `Cannot ${op} ${describeCookie(name)}: this route was registered before the cookie plugin, and its ` +
          'responses carry no cookies' +
          solutions(
            'Register the plugin that declares the route with ".with(...)" rather than in ".serverCallback(...)"',
          ),
      )
    }

    if (reply.sent || reply.raw.headersSent) {
      throw new ErrCookieTooLate(`Cannot ${op} ${describeCookie(name)}: the response's headers are already sent`)
    }

    const prepared = prepareCookie(op, name, this.#defaults, options, request.protocol === 'https')

    if (!prepared.signed) {
      const line = serializeCookie(op, prepared, value)

      if (state === 'done') {
        writeLines(reply, [line])
      } else {
        pendingOf(cookieReply).set(prepared.key, { op, prepared, value, line })
      }

      return
    }

    if (prepared.secret === undefined && !this.#signsByDefault) {
      throw new ErrCookieConfiguration(
        `Cannot set ${describeCookie(name)} signed: no secret is configured` +
          solutions('Configure one with ".cookie(k => k.secret(...))"', 'Hand one to the call: "{ secret }"'),
      )
    }

    // The built-in signer's rules for a secret, checked here so a bad one fails where it was written. A custom
    // signer decides what a secret is.
    if (prepared.secret !== undefined && this.#signer instanceof HMACCookieSigner) {
      secretList(prepared.secret)
    }

    if (state === 'done') {
      throw new ErrCookieTooLate(
        `Cannot set ${describeCookie(name)} signed: the response's cookies are already written` +
          solutions('Set it before the response is sent: in the handler, a middleware or a guard'),
      )
    }

    assertWritable(op, prepared)
    pendingOf(cookieReply).set(prepared.key, { op, prepared, value, line: undefined })
  }

  /** Writes what `reply` queued, signing first what has to be. */
  flush(reply: FastifyReply, done: HookHandlerDoneFunction): void {
    const cookieReply = reply as unknown as CookieReply

    // An earlier pass wrote them: the error response a failure in a later hook sends, say.
    if (cookieReply[kCookieFlush] === 'done') {
      done()
      return
    }

    cookieReply[kCookieFlush] = 'open'

    const pending = cookieReply[kPendingCookies]
    if (pending === null || pending.size === 0) {
      cookieReply[kCookieFlush] = 'done'
      done()
      return
    }

    if (!hasUnsigned(pending)) {
      this.#write(cookieReply, reply, pending)
      done()
      return
    }

    this.#sign(pending).then(
      () => {
        this.#write(cookieReply, reply, pending)
        done()
      },
      (err: unknown) => {
        // The batch goes with the response it was for. A cookie the error handler sets is queued afresh and
        // written by the error response's own pass.
        cookieReply[kPendingCookies] = null
        cookieReply[kCookieFlush] = 'failed'
        done(err as Error)
      },
    )
  }

  // Until none is left unsigned: a cookie queued while the others were signing is written too.
  async #sign(pending: Map<string, PendingCookie>): Promise<void> {
    for (let unsigned = [...pending.values()].filter(cookie => cookie.line === undefined); unsigned.length > 0;) {
      await Promise.all(
        unsigned.map(async cookie => {
          const signed = await this.#signer.sign(cookie.value, cookie.prepared.secret)
          cookie.line = serializeCookie(cookie.op, cookie.prepared, signed)
        }),
      )

      unsigned = [...pending.values()].filter(cookie => cookie.line === undefined)
    }
  }

  #write(cookieReply: CookieReply, reply: FastifyReply, pending: Map<string, PendingCookie>): void {
    const lines: string[] = []
    for (const cookie of pending.values()) {
      lines.push(cookie.line!)
    }

    cookieReply[kPendingCookies] = null
    cookieReply[kCookieFlush] = 'done'
    writeLines(reply, lines)
  }
}

/**
 * The cookie plugin of one server. It resolves the signer once, here, decorates the server with what every request
 * reads, and writes each response's cookies from a root `onSend` hook — which runs ahead of every hook a later plugin
 * or a route adds, so one that inspects `Set-Cookie`, as HTTP caching does, sees them.
 *
 * @throws ErrCookieConfiguration while the server starts, when the signer cannot be had: both a signer and a secret
 * given, a key nothing is bound to, a short secret.
 */
export function cookiePlugin(options: CookiePluginOptions): FastifyPluginAsync {
  return fp(
    async (instance: FastifyInstance) => {
      if (!options.enabled) {
        return
      }

      const { signer, signsByDefault } = resolveSigner(instance, options)
      const cookies = new ServerCookies(signer, signsByDefault, options.parseOptions)

      instance.decorate(kServerCookies, cookies)
      instance.decorateReply(kPendingCookies, null)
      instance.decorateReply(kCookieFlush, 'open')
      instance.addHook('onSend', (_request, reply, _payload, done) => cookies.flush(reply, done))
    },
    { name: 'caffeine-cookie' },
  )
}

/**
 * The cookies of the server `request` came to.
 *
 * @throws ErrCookiesDisabled when that server has no cookie plugin.
 */
export function serverCookies(request: FastifyRequest, action: string): ServerCookies {
  const cookies = (request.server as unknown as CookieInstance)[kServerCookies]

  if (cookies === undefined) {
    throw new ErrCookiesDisabled(
      `Cannot ${action}: cookies are disabled on this server` +
        solutions('Turn them back on with ".cookie(k => k.enabled(true))"'),
    )
  }

  return cookies
}

/** Whether `instance` has a cookie plugin. */
export function hasServerCookies(instance: FastifyInstance): boolean {
  return (instance as unknown as CookieInstance)[kServerCookies] !== undefined
}

/** Whether writing `reply`'s cookies failed, so the response they were for never went out. */
export function cookieFlushFailed(reply: FastifyReply): boolean {
  return (reply as unknown as CookieReply)[kCookieFlush] === 'failed'
}

/** Marks a new send of `reply`, after a failed one: its cookies are written by that send's own pass. */
export function reopenCookieFlush(reply: FastifyReply): void {
  const cookieReply = reply as unknown as CookieReply

  if (cookieReply[kCookieFlush] === 'failed') {
    cookieReply[kCookieFlush] = 'open'
  }
}

function resolveSigner(
  instance: FastifyInstance,
  options: CookiePluginOptions,
): { signer: CookieSigner; signsByDefault: boolean } {
  const { signer, secret, algorithm } = options

  if (signer === undefined) {
    return { signer: new HMACCookieSigner({ secret, algorithm }), signsByDefault: secret !== undefined }
  }

  if (secret !== undefined) {
    throw new ErrCookieConfiguration(
      'Cannot install cookies: both a signer and a secret are configured' +
        solutions('Keep the signer: it signs with keys of its own', 'Keep the secret: it builds the HMAC signer'),
    )
  }

  if (!isValidKey<CookieSigner>(signer)) {
    return { signer: assertSigner(signer), signsByDefault: true }
  }

  const resolved = instance.$container.getOptional(signer)
  if (resolved === undefined) {
    throw new ErrCookieConfiguration(
      'Cannot install cookies: no binding registered for the given signer key' +
        solutions('Bind the signer before the application starts', 'Pass the instance itself to ".signer(...)"'),
    )
  }

  return { signer: assertSigner(resolved), signsByDefault: true }
}

function assertSigner(value: unknown): CookieSigner {
  const candidate = value as Partial<CookieSigner> | null

  if (typeof candidate?.sign !== 'function' || typeof candidate.unsign !== 'function') {
    throw new ErrCookieConfiguration('Cannot install cookies: the signer has no "sign" and "unsign" methods')
  }

  return candidate as CookieSigner
}

function pendingOf(cookieReply: CookieReply): Map<string, PendingCookie> {
  return (cookieReply[kPendingCookies] ??= new Map())
}

function hasUnsigned(pending: Map<string, PendingCookie>): boolean {
  for (const cookie of pending.values()) {
    if (cookie.line === undefined) {
      return true
    }
  }

  return false
}

// Merged, never replaced: a value the route set with `@Header('Set-Cookie')`, another plugin wrote, or a raw
// `res.setHeader` left goes out ahead of these. Never an empty list either, which would read as a cookie to caching.
function writeLines(reply: FastifyReply, lines: readonly string[]): void {
  if (lines.length === 0) {
    return
  }

  const current = reply.getHeader('set-cookie')
  reply.removeHeader('set-cookie')
  reply.header(
    'set-cookie',
    current === undefined ? lines : [...(Array.isArray(current) ? current : [String(current)]), ...lines],
  )
}
