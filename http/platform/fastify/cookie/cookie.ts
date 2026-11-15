import { errMessage } from '@caffeinejs/std/err'
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { ErrCookiesDisabled } from '../../../core/cookie/errors.js'
import type { CookiePluginOptions } from '../../../core/cookie/keys.js'
import type { CookieSerializeOptions } from '../../../core/cookie/options.js'
import { describeCookie, type CookieOperation } from '../../../core/cookie/serialize.js'
import {
  kCookieFlush,
  kPendingCookies,
  requireCookies,
  ServerCookies,
  type CookieJar,
} from '../../../core/cookie/server_cookies.js'
import { isThenable } from '../../../core/lifecycle/lifecycle.js'
import { protocolOf } from '../protocol.js'

const kServerCookies = Symbol('caffeine.http.cookies')

/** A reply the cookie plugin decorated: its own cookies' jar. */
type CookieReply = FastifyReply & CookieJar

/**
 * Any reply. Its flush state is `undefined` on one the plugin never decorated: one of a route whose context was created
 * before the plugin registered, which runs none of its hooks.
 */
type AnyReply = Partial<CookieJar>

interface CookieInstance {
  [kServerCookies]?: ServerCookies<CookieReply>
}

/**
 * The cookie plugin of one server. It resolves the signer once, here, decorates the server with what every request
 * reads, and writes each response's cookies from a root `onSend` hook — which runs ahead of every hook a later plugin
 * or a route adds, so one that inspects `Set-Cookie`, as HTTP caching does, sees them.
 *
 * @throws ErrCookieConfiguration while the server starts, when the signer cannot be had: a signer given with a secret
 * or an algorithm, a key nothing is bound to, a short secret.
 */
export function cookiePlugin(options: CookiePluginOptions): FastifyPluginAsync {
  return fp(
    async (instance: FastifyInstance) => {
      if (!options.enabled) {
        return
      }

      const cookies = ServerCookies.resolve<CookieReply>(options, instance.$container, writeLines)

      instance.decorate(kServerCookies, cookies)
      instance.decorateReply(kPendingCookies, null)
      instance.decorateReply(kCookieFlush, 'open')
      instance.addHook('onSend', (_request, reply, _payload, done) => {
        let flushed: void | Promise<void>
        try {
          flushed = cookies.flush(reply as CookieReply)
        } catch (err) {
          done(err as Error)
          return
        }

        if (isThenable(flushed)) {
          flushed.then(
            () => done(),
            (err: unknown) => done(err as Error),
          )
        } else {
          done()
        }
      })
    },
    { name: 'caffeine-cookie' },
  )
}

/**
 * The cookies of the server `request` came to.
 *
 * @throws ErrCookiesDisabled when that server has no cookie plugin.
 */
export function serverCookies(request: FastifyRequest, action: string): ServerCookies<CookieReply> {
  return requireCookies((request.server as unknown as CookieInstance)[kServerCookies], action)
}

/**
 * Sets or deletes a cookie on `reply`.
 *
 * @throws ErrCookiesDisabled when the server has no cookie plugin, or the route was registered before it; and as
 *   `ServerCookies.queue` does.
 */
export function setCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  op: CookieOperation,
  name: string,
  value: string,
  options: CookieSerializeOptions | undefined,
): void {
  const cookies = serverCookies(request, `${op} cookies`)

  if ((reply as AnyReply)[kCookieFlush] === undefined) {
    throw new ErrCookiesDisabled(
      errMessage(
        `Cannot ${op} ${describeCookie(name)}: this route was registered before the cookie plugin, and its ` +
          'responses carry no cookies',
      )
        .solutions(
          'Register the plugin that declares the route with ".with(...)" rather than in ".serverCallback(...)"',
        )
        .reference('@caffeinejs/http', ErrCookiesDisabled)
        .build(),
    )
  }

  cookies.queue(reply as CookieReply, op, name, value, options, {
    secure: protocolOf(request) === 'https',
    late: reply.sent || reply.raw.headersSent,
  })
}

/** Whether `instance` has a cookie plugin. */
export function hasServerCookies(instance: FastifyInstance): boolean {
  return (instance as unknown as CookieInstance)[kServerCookies] !== undefined
}

/** Whether writing `reply`'s cookies failed, so the response they were for never went out. */
export function cookieFlushFailed(reply: FastifyReply): boolean {
  return (reply as AnyReply)[kCookieFlush] === 'failed'
}

/** Marks a new send of `reply`, after a failed one: its cookies are written by that send's own pass. */
export function reopenCookieFlush(reply: FastifyReply): void {
  const cookieReply = reply as AnyReply

  if (cookieReply[kCookieFlush] === 'failed') {
    cookieReply[kCookieFlush] = 'open'
  }
}

// Merged, never replaced: a value the route set with `@Header('Set-Cookie')`, another plugin wrote, or a raw
// `res.setHeader` left goes out ahead of these. Never handed an empty list, which would read as a cookie to caching:
// `flush` writes nothing when nothing is pending.
function writeLines(reply: CookieReply, lines: readonly string[]): void {
  const current = reply.getHeader('set-cookie')
  reply.removeHeader('set-cookie')
  reply.header(
    'set-cookie',
    current === undefined ? lines : [...(Array.isArray(current) ? current : [String(current)]), ...lines],
  )
}
