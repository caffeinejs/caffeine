import { isValidKey, type Container } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type { UnsignedCookie } from '../../request.js'
import { ErrCookieConfiguration, ErrCookiesDisabled, ErrCookieTooLate } from './errors.js'
import type { CookiePluginOptions } from './keys.js'
import type { CookieSerializeOptions } from './options.js'
import {
  assertWritable,
  cookieDefaults,
  describeCookie,
  parseCookies,
  prepareCookie,
  serializeCookie,
  type CookieOperation,
  type PreparedCookie,
} from './serialize.js'
import {
  CookieSigner,
  HMACCookieSigner,
  kSigning,
  secretList,
  type CookieSecret,
  type CookieUnsignResult,
} from './signer.js'

export const kPendingCookies = Symbol('caffeine.http.cookies.pending')
export const kCookieFlush = Symbol('caffeine.http.cookies.flush')

/** Where one response's cookies stand. `failed`: signing failed, and the batch went with that response. */
export type CookieFlushState = 'open' | 'done' | 'failed'

export interface PendingCookie {
  readonly op: CookieOperation
  readonly prepared: PreparedCookie
  readonly value: string
  /** The `Set-Cookie` line, or `undefined` until the value is signed. */
  line: string | undefined
}

/**
 * One response's cookies: the engine's context.
 */
export interface CookieJar {
  [kPendingCookies]: Map<string, PendingCookie> | null
  [kCookieFlush]: CookieFlushState
}

/** Writes `Set-Cookie` lines on `jar`'s response, after any it already carries. Never handed an empty list. */
export type CookieWriter<J extends CookieJar> = (jar: J, lines: readonly string[]) => void

/** The signer a server settled on as it started, and what it knows of it. */
interface ResolvedSigner {
  readonly signer: CookieSigner
  /** Whether it signs without a secret handed to the call. */
  readonly signsByDefault: boolean
  /** How long its signatures are: known for the built-in signer, not for one of the application's. */
  readonly signatureLength: number | undefined
}

/** One server's cookies: its signer, defaults and writer, settled as the server starts. */
export class ServerCookies<J extends CookieJar> {
  readonly #signer: CookieSigner
  readonly #signsByDefault: boolean
  // A stand-in for the signature, when its length is known: a dot and as many base64 characters.
  readonly #signature: string | undefined
  readonly #defaults: CookieSerializeOptions
  readonly #decode: ((value: string) => string | undefined) | undefined
  readonly #writer: CookieWriter<J>

  private constructor(resolved: ResolvedSigner, options: CookiePluginOptions, write: CookieWriter<J>) {
    const { defaults, decode } = cookieDefaults(options.parseOptions)

    this.#signer = resolved.signer
    this.#signsByDefault = resolved.signsByDefault
    this.#signature = resolved.signatureLength === undefined ? undefined : `.${'A'.repeat(resolved.signatureLength)}`
    this.#defaults = defaults
    this.#decode = decode
    this.#writer = write
  }

  /**
   * The cookies a server runs with, from the cookie feature's settings.
   *
   * @throws ErrCookieConfiguration for a signer given with a secret or an algorithm, a key nothing is bound to, a
   *   value that is no signer, or a secret the built-in signer refuses.
   */
  static resolve<J extends CookieJar>(
    options: CookiePluginOptions,
    container: Container,
    write: CookieWriter<J>,
  ): ServerCookies<J> {
    return new ServerCookies(resolveSigner(options, container), options, write)
  }

  /** The cookies a `Cookie` header carries. */
  parse(header: string | undefined): Record<string, string> {
    return parseCookies(header, this.#decode)
  }

  /**
   * What verifying `signed` found: with `secret` when one is given, otherwise with the server's signer. A value that
   * does not verify is a result, never a rejection.
   *
   * @throws ErrCookieConfiguration when there is nothing to verify with.
   */
  unsign(signed: string, secret: CookieSecret | undefined): Promise<CookieUnsignResult> {
    return this.#signer.unsign(signed, secret)
  }

  /**
   * What `ctx.req.signedCookie(...)` answers: the value of the cookie `name`, `false` when it does not verify and
   * `undefined` when the request does not carry it; with no name, every cookie's.
   */
  async signed(
    cookies: Record<string, string>,
    name: string | undefined,
    secret: CookieSecret | undefined,
  ): Promise<UnsignedCookie | Record<string, UnsignedCookie>> {
    if (name !== undefined) {
      const raw = cookies[name]

      return raw === undefined ? undefined : this.#verify(raw, secret)
    }

    const names = Object.keys(cookies)
    const values = await Promise.all(names.map(cookie => this.#verify(cookies[cookie]!, undefined)))

    return Object.fromEntries(names.map((cookie, i) => [cookie, values[i]]))
  }

  /**
   * Queues a cookie on `jar`, or writes it at once when the jar was flushed and it needs no signature.
   *
   * @param at - `secure`: whether the request came over HTTPS. `late`: whether nothing set now can go out any more.
   * @throws ErrCookieTooLate when `late`, or for a signed cookie once the jar was flushed.
   * @throws ErrCookieConfiguration for a signed cookie with nothing to sign with.
   * @throws ErrInvalidCookie for a name, value or attributes a browser would drop.
   */
  queue(
    jar: J,
    op: CookieOperation,
    name: string,
    value: string,
    options: CookieSerializeOptions | undefined,
    at: { readonly secure: boolean; readonly late: boolean },
  ): void {
    if (at.late) {
      throw new ErrCookieTooLate(
        errMessage(`Cannot ${op} ${describeCookie(name)}: the response's headers are already sent`)
          .reference('@caffeinejs/http', ErrCookieTooLate)
          .build(),
      )
    }

    const state = jar[kCookieFlush]
    const prepared = prepareCookie(op, name, this.#defaults, options, at.secure)

    if (!prepared.signed) {
      const line = serializeCookie(op, prepared, value)

      if (state === 'done') {
        this.#writer(jar, [line])
      } else {
        pendingOf(jar).set(prepared.key, { op, prepared, value, line })
      }

      return
    }

    if (prepared.secret === undefined && !this.#signsByDefault) {
      throw new ErrCookieConfiguration(
        errMessage(`Cannot set ${describeCookie(name)} signed: no secret is configured`)
          .solutions('Configure one with ".cookie(k => k.secret(...))"', 'Hand one to the call: "{ secret }"')
          .reference('@caffeinejs/http', ErrCookieConfiguration)
          .build(),
      )
    }

    // The built-in signer's rules for a secret, checked here so a bad one fails where it was written. A custom
    // signer decides what a secret is.
    if (prepared.secret !== undefined && this.#signer instanceof HMACCookieSigner) {
      secretList(prepared.secret)
    }

    if (state === 'done') {
      throw new ErrCookieTooLate(
        errMessage(`Cannot set ${describeCookie(name)} signed: the response's cookies are already written`)
          .solutions('Set it before the response is sent: in the handler, a middleware or a guard')
          .reference('@caffeinejs/http', ErrCookieTooLate)
          .build(),
      )
    }

    // Checked as it will be written, with a stand-in for the signature it does not have yet. The built-in signer's
    // length is known, and its base64 grows only when the value itself needs URL-encoding, which the flush still
    // catches. A custom signer's output is checked when the response goes out, its attributes here.
    assertWritable(op, prepared, this.#signature === undefined ? '' : `${value}${this.#signature}`)
    pendingOf(jar).set(prepared.key, { op, prepared, value, line: undefined })
  }

  /**
   * Writes what `jar` queued, signing first what has to be, and marks it `done`. Synchronous unless something is
   * signed. A rejection leaves the jar `failed`, its batch dropped.
   */
  flush(jar: J): void | Promise<void> {
    // An earlier pass wrote them: the error response a failure in a later hook sends, say.
    if (jar[kCookieFlush] === 'done') {
      return
    }

    jar[kCookieFlush] = 'open'

    const pending = jar[kPendingCookies]
    if (pending === null || pending.size === 0) {
      jar[kCookieFlush] = 'done'
      return
    }

    if (!hasUnsigned(pending)) {
      this.#writePending(jar, pending)
      return
    }

    return this.#sign(pending).then(
      () => this.#writePending(jar, pending),
      (err: unknown) => {
        // The batch goes with the response it was for. A cookie the error handler sets is queued afresh and
        // written by the error response's own pass.
        jar[kPendingCookies] = null
        jar[kCookieFlush] = 'failed'
        throw err
      },
    )
  }

  /** The value `signed` carries, or `false` when it does not verify. */
  async #verify(signed: string, secret: CookieSecret | undefined): Promise<string | false> {
    const result = await this.unsign(signed, secret)

    return result.valid ? result.value : false
  }

  // Until none is left unsigned: a cookie queued while these were signing is signed by the next round.
  async #sign(pending: Map<string, PendingCookie>): Promise<void> {
    const unsigned = [...pending.values()].filter(cookie => cookie.line === undefined)
    if (unsigned.length === 0) {
      return
    }

    await Promise.all(
      unsigned.map(async cookie => {
        const signed = await this.#signer.sign(cookie.value, cookie.prepared.secret)
        cookie.line = serializeCookie(cookie.op, cookie.prepared, signed)
      }),
    )

    return this.#sign(pending)
  }

  #writePending(jar: J, pending: Map<string, PendingCookie>): void {
    const lines: string[] = []
    for (const cookie of pending.values()) {
      lines.push(cookie.line!)
    }

    jar[kPendingCookies] = null
    jar[kCookieFlush] = 'done'
    this.#writer(jar, lines)
  }
}

/** What reading or writing a cookie throws on a server whose cookies are off. */
function cookiesDisabled(action: string): ErrCookiesDisabled {
  return new ErrCookiesDisabled(
    errMessage(`Cannot ${action}: cookies are disabled on this server`)
      .solutions('Turn them back on with ".cookie(k => k.enabled(true))"')
      .reference('@caffeinejs/http', ErrCookiesDisabled)
      .build(),
  )
}

/**
 * The server's cookies, as one who reads or writes a cookie needs them.
 *
 * @throws ErrCookiesDisabled when the server's cookies are off.
 */
export function requireCookies<J extends CookieJar>(
  cookies: ServerCookies<J> | undefined,
  action: string,
): ServerCookies<J> {
  if (cookies === undefined) {
    throw cookiesDisabled(action)
  }

  return cookies
}

function resolveSigner(options: CookiePluginOptions, container: Container): ResolvedSigner {
  const { signer, secret, algorithm } = options

  if (signer === undefined) {
    return described(new HMACCookieSigner({ secret, algorithm }))
  }

  if (secret !== undefined) {
    throw new ErrCookieConfiguration(
      errMessage('Cannot install cookies: both a signer and a secret are configured')
        .solutions('Keep the signer: it signs with keys of its own', 'Keep the secret: it builds the HMAC signer')
        .reference('@caffeinejs/http', ErrCookieConfiguration)
        .build(),
    )
  }

  if (algorithm !== undefined) {
    throw new ErrCookieConfiguration(
      errMessage('Cannot install cookies: both a signer and an algorithm are configured')
        .solutions(
          'Keep the signer: it signs as it was built to',
          'Keep the algorithm: it is the hash of the HMAC signer',
        )
        .reference('@caffeinejs/http', ErrCookieConfiguration)
        .build(),
    )
  }

  if (!isValidKey<CookieSigner>(signer)) {
    return described(assertSigner(signer))
  }

  const resolved = container.getOptional(signer)
  if (resolved === undefined) {
    throw new ErrCookieConfiguration(
      errMessage('Cannot install cookies: no binding registered for the given signer key')
        .solutions('Bind the signer before the application starts', 'Pass the instance itself to ".signer(...)"')
        .reference('@caffeinejs/http', ErrCookieConfiguration)
        .build(),
    )
  }

  return described(assertSigner(resolved))
}

// The built-in signer tells whether it has secrets of its own and how long its signatures are. An application's signer
// tells neither, and is taken to sign by default.
function described(signer: CookieSigner): ResolvedSigner {
  if (signer instanceof HMACCookieSigner) {
    const { configured, signatureLength } = signer[kSigning]
    return { signer, signsByDefault: configured, signatureLength }
  }

  return { signer, signsByDefault: true, signatureLength: undefined }
}

function assertSigner(value: unknown): CookieSigner {
  const candidate = value as Partial<CookieSigner> | null

  if (typeof candidate?.sign !== 'function' || typeof candidate.unsign !== 'function') {
    throw new ErrCookieConfiguration(
      errMessage('Cannot install cookies: the signer has no "sign" and "unsign" methods')
        .reference('@caffeinejs/http', ErrCookieConfiguration)
        .build(),
    )
  }

  return candidate as CookieSigner
}

function pendingOf(jar: CookieJar): Map<string, PendingCookie> {
  return (jar[kPendingCookies] ??= new Map())
}

function hasUnsigned(pending: Map<string, PendingCookie>): boolean {
  for (const cookie of pending.values()) {
    if (cookie.line === undefined) {
      return true
    }
  }

  return false
}
