import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import type { Context } from '../context.js'
import type { HTTPPluginConfigurer, HTTPPluginFactory } from '../plugin.js'
import { protocolOf } from '../protocol.js'
import { ErrCSRFCrossOrigin } from './errors.js'
import {
  isExcluded,
  resolveCSRFOptions,
  type CSRFConfig,
  type CSRFOptions,
  type OriginPredicate,
  type SecFetchSitePredicate,
} from './options.js'
import { checkOrigin, SAFE_METHODS, type OriginCheckAskable, type OriginCheckInput } from './origin.js'
import { csrfMarkOf } from './route.js'

const kBuild = Symbol('caffeine.http.csrf.build')

/**
 * Authors one `csrf()` plugin's settings. The callback runs while the factory builds the plugin, handed the same
 * `HTTPSetupContext` the factory gets, so a setting can come from the configuration.
 *
 * What a fluent method sets is final: `trustedOrigins(...)` or `exclude(...)` written here replaces what the node
 * handed to {@link config} carries. The checks of {@link trustOrigin} and {@link allowSecFetchSite} are code only, and
 * stand beside whatever the node carries.
 */
export class CSRFBuilder {
  #label = 'default'
  #config: CSRFConfig | undefined
  #enabled: boolean | undefined
  #trustedOrigins: string[] | undefined
  #exclude: string[] | undefined
  readonly #originChecks: OriginPredicate[] = []
  readonly #siteChecks: SecFetchSitePredicate[] = []

  /**
   * Reads the settings from a node of the configuration tree, e.g. `config.app.csrf`. The node is read once, when
   * the plugin is built. A fluent method called alongside wins over what the node carries.
   */
  config(config: CSRFConfig): this {
    this.#config = config
    return this
  }

  /**
   * Turns the check off, which registers nothing and says so once, at `warn`, as the server starts: for an
   * environment where every client is a non-browser.
   */
  enabled(enabled: boolean = true): this {
    this.#enabled = enabled
    return this
  }

  /**
   * Origins a cross-origin request may come from, each `scheme://host[:port]`: a front-end served from another
   * origin, a partner's site posting a form here, or the public origin of a proxy that rewrites `Host`.
   *
   * @throws ErrCSRFConfiguration at start-up when one is not an origin.
   */
  trustedOrigins(...origins: string[]): this {
    this.#trustedOrigins = [...(this.#trustedOrigins ?? []), ...origins]
    return this
  }

  /**
   * Registered route paths the check leaves alone, each a prefix of whole segments: `/webhooks` covers `/webhooks`
   * and `/webhooks/stripe`, not `/webhooks-old`. Judged by the path a route was registered under, never the URL
   * requested. For a route the application cannot mark itself; its own are marked with `@CSRFExempt()`,
   * `csrfExempt()` or `csrfExemptConfig()`, and a route's own mark wins: `csrfExempt(false)` keeps it protected
   * under an excluded prefix.
   *
   * @throws ErrCSRFConfiguration at start-up when one does not start with `/`, or is `/` itself.
   */
  exclude(...prefixes: string[]): this {
    this.#exclude = [...(this.#exclude ?? []), ...prefixes]
    return this
  }

  /**
   * Lets through a request the check would refuse when `check` trusts its origin: what no exact list can spell,
   * such as every subdomain of a domain, or a tenant's own domain.
   *
   * Asked only once the exemptions, the rules and {@link trustedOrigins} have refused the request, and only about
   * an `http:` or `https:` origin: `Origin: null`, a malformed origin, and an `http:` origin on a request known to be
   * HTTPS stay refused whatever it answers. `origin` is a fresh URL of the origin alone; compare its `hostname` and
   * `protocol`, never a prefix of the string, which `https://app.example.com.evil.example` would pass.
   *
   * Only `true`, or a promise of it, lets the request through; a throw or a rejection fails the request with that
   * error. It runs before the body is read and, written ahead of `.with(authentication())`, before anyone is
   * authenticated. Any page can make its visitors' browsers ask it, so it must be cheap: cache a lookup. Each call
   * adds a check, asked in the order written, and the first `true` wins.
   */
  trustOrigin(check: OriginPredicate): this {
    this.#originChecks.push(check)
    return this
  }

  /**
   * Lets through a request the check would refuse when `check` accepts its `Sec-Fetch-Site`, `same-site` or
   * `cross-site`. `same-site` takes in every subdomain of the site, one a user can publish to or one taken over
   * included; {@link trustOrigin} can name the hosts instead.
   *
   * Asked after every {@link trustOrigin} check has declined, and only when the request also carries an `http:` or
   * `https:` origin that is not a downgrade: a browser too old to send the header is never asked about, nor is
   * `Origin: null`. Answers and failures are read as for {@link trustOrigin}. Each call adds a check, asked in the
   * order written, and the first `true` wins.
   */
  allowSecFetchSite(check: SecFetchSitePredicate): this {
    this.#siteChecks.push(check)
    return this
  }

  /**
   * Names this plugin. The label distinguishes its `fastify-plugin` registration, `caffeine-csrf` for the default
   * and `caffeine-csrf:<label>` otherwise, so a second plugin on one registration chain, a scoped one under a root
   * one, must carry its own label, and an accidental duplicate is refused at start-up.
   */
  name(label: string): this {
    this.#label = label
    return this
  }

  [kBuild](): { label: string; options: CSRFOptions } {
    return {
      label: this.#label,
      options: resolveCSRFOptions(
        {
          enabled: this.#enabled ?? this.#config?.enabled,
          trustedOrigins: this.#trustedOrigins ?? this.#config?.trustedOrigins,
          exclude: this.#exclude ?? this.#config?.exclude,
        },
        { originChecks: [...this.#originChecks], siteChecks: [...this.#siteChecks] },
      ),
    }
  }
}

/**
 * Cross-origin protection by Fetch Metadata: `.with(csrf())`.
 *
 * Every request with an unsafe method is judged by `Sec-Fetch-Site`, then by `Origin` against the request's host
 * ({@link checkOrigin}), and refused with {@link ErrCSRFCrossOrigin}, a 403, when it comes from another origin. A
 * browser sends both headers of its own accord and no script can forge them, so a page this application serves needs
 * no token: its requests are `same-origin`. A request carrying neither header is let through, as a non-browser
 * client's, which carries no cookies of a victim.
 *
 * The check is a root `onRequest` hook of the server the plugin is registered on, ahead of body parsing, so a refused
 * request costs nothing past its headers. Where it sits among the plugins is where `.with(csrf())` was written:
 * ahead of `.with(authentication())`, a cross-origin request is refused before anyone is authenticated.
 *
 * An origin no exact list can spell, every subdomain of a domain or a tenant's own, is let through by
 * `c.trustOrigin(...)`, and a `Sec-Fetch-Site` of `same-site` by `c.allowSecFetchSite(...)`. Each is asked only about
 * a request the rules refused, and neither lets through `Origin: null`, a malformed origin, or an `http:` origin on a
 * request known to be HTTPS.
 *
 * A route is left alone when it is marked with `@CSRFExempt()`, `csrfExempt()` or `csrfExemptConfig()`, or, unmarked,
 * when its registered path is under `.exclude(...)`. A URL no route matched is the not-found handler's. An ops
 * server is covered by its own `Ops(name, o => o.with(csrf()))`, a route group by
 * `router.plugin(csrf(c => c.name('admin')))`.
 *
 * @throws ErrCSRFConfiguration at start-up for a trusted origin that is not one, or an excluded path not starting
 * with `/` or that is `/` itself.
 */
export function csrf<C = unknown>(configure?: HTTPPluginConfigurer<CSRFBuilder, C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new CSRFBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written, not inside Fastify.
    const { label, options } = builder[kBuild]()
    const name = label === 'default' ? 'caffeine-csrf' : `caffeine-csrf:${label}`
    const asks = options.originChecks.length > 0 || options.siteChecks.length > 0

    const plugin: FastifyPluginAsync = async instance => {
      if (!options.enabled) {
        instance.log.warn({ plugin: name }, 'Cross-origin protection is turned off')
        return
      }

      // Callback style, not `async`: most requests are decided without a promise, and a check's own promise is
      // followed with `then`.
      instance.addHook('onRequest', (request, _reply, done) => {
        if (SAFE_METHODS.has(request.method) || request.is404) {
          done()
          return
        }

        // A route's own mark is the more specific word: `csrfExempt(false)` keeps it under an excluded prefix.
        const route = request.routeOptions
        const mark = csrfMarkOf(route.config)
        if (mark === true || (mark === undefined && isExcluded(route.url ?? '', options.exclude))) {
          done()
          return
        }

        const input = inputOf(request)
        const { verdict, reason, askable } = checkOrigin(input, options)
        if (verdict !== 'deny') {
          done()
          return
        }

        const refuse = (): void => {
          request.log.warn(
            {
              reason,
              method: input.method,
              path: pathOf(request.url),
              host: input.host,
              origin: input.origin,
              secFetchSite: input.secFetchSite,
            },
            'Cross-origin request refused',
          )
          done(new ErrCSRFCrossOrigin(reason))
        }

        if (!asks || askable === undefined) {
          refuse()
          return
        }

        ask(questionsOf(request.httpContext, askable, options), 0, refuse, done)
      })
    }

    return fp(plugin, { name })
  }
}

type Question = () => boolean | PromiseLike<boolean>

// Origin checks first, then site checks, each in the order written; every one is handed its own URL.
function questionsOf(ctx: Context, askable: OriginCheckAskable, options: CSRFOptions): Question[] {
  const questions: Question[] = options.originChecks.map(check => () => check(ctx, new URL(askable.origin)))

  const site = askable.site
  if (site !== undefined) {
    for (const check of options.siteChecks) {
      questions.push(() => check(ctx, site))
    }
  }

  return questions
}

// Asks each check in turn, with no microtask for an answer that is not a promise. Only `true` lets the request
// through. Nothing past the call may throw: after a promise, nothing above this frame would catch it.
function ask(questions: readonly Question[], from: number, refuse: () => void, done: (err?: Error) => void): void {
  for (let i = from; i < questions.length; i++) {
    let answer: unknown

    try {
      answer = questions[i]!()

      if (isThenable(answer)) {
        // Adopted, so a thenable that settles twice, or throws from `then`, is answered once.
        Promise.resolve(answer).then(
          value => (value === true ? done() : ask(questions, i + 1, refuse, done)),
          (err: unknown) => done(failure(err)),
        )
        return
      }
    } catch (err) {
      done(failure(err))
      return
    }

    if (answer === true) {
      done()
      return
    }
  }

  refuse()
}

function isThenable(value: unknown): value is PromiseLike<boolean> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}

// A falsy error reads as "continue" to Fastify: a check that failed would let the request through, past every hook
// after this one.
function failure(err: unknown): Error {
  return err instanceof Error
    ? err
    : new Error('Cannot check the request origin: a check failed with a non-error value', { cause: err })
}

function inputOf(request: FastifyRequest): OriginCheckInput {
  return {
    method: request.method,
    secFetchSite: headerOf(request.headers['sec-fetch-site']),
    origin: headerOf(request.headers.origin),
    host: request.host,
    protocol: protocolOf(request),
  }
}

// A header sent twice reads as one value no browser writes, which the check refuses.
function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

// The query can carry a token a webhook sender was handed, and the check never reads it.
function pathOf(url: string): string {
  const query = url.indexOf('?')

  return query === -1 ? url : url.slice(0, query)
}
