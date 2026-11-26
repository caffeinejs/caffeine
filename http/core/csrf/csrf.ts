import { HTTPPlugin, type HTTPPluginConfigurer, type HTTPPluginFactory, type HTTPSetupContext } from '../../plugin.js'
import type { RouteDefinition } from '../lifecycle/route_definition.js'
import type { LiteralPrefix } from '../routing/paths.js'
import { ErrCSRFCrossOrigin } from './errors.js'
import {
  isExcluded,
  resolveCSRFOptions,
  type CSRFConfig,
  type CSRFOptions,
  type OriginPredicate,
  type SecFetchSitePredicate,
} from './options.js'
import { checkOrigin, questionsOf, SAFE_METHODS, type OriginCheckInput } from './origin.js'

export const kBuild = Symbol('caffeine.http.csrf.build')

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
   * requested. For a route the application cannot mark itself; its own are marked with `@CSRFExempt()` or
   * `csrfExempt()`, and a route's own mark wins: `csrfExempt(false)` keeps it protected under an excluded prefix.
   *
   * A missing leading `/` is added.
   *
   * @throws ErrCSRFConfiguration at start-up when one is `/` itself, or starts with `~/`.
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

  /** Names this plugin: `caffeine-csrf` for the default, `caffeine-csrf:<label>` otherwise. */
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
 * The check is an `onRequest` hook, ahead of body parsing, so a refused request costs nothing past its headers. It runs
 * where `.with(csrf())` was written among the plugins: ahead of `.with(authentication())`, a cross-origin request is
 * refused before anyone is authenticated.
 *
 * An origin no exact list can spell, every subdomain of a domain or a tenant's own, is let through by
 * `c.trustOrigin(...)`, and a `Sec-Fetch-Site` of `same-site` by `c.allowSecFetchSite(...)`. Each is asked only about
 * a request the rules refused, and neither lets through `Origin: null`, a malformed origin, or an `http:` origin on a
 * request known to be HTTPS. A check that throws or rejects fails the request.
 *
 * A route is left alone when it is marked with `@CSRFExempt()` or `csrfExempt()`, or, unmarked, when its registered
 * path is under `.exclude(...)`. A URL no route matched is the not-found answer's. A listener is covered by its own
 * `.listener(name, l => l.with(csrf()))`, a route group by `router.with(csrf())`.
 *
 * @throws ErrCSRFConfiguration at start-up for a trusted origin that is not one, or an excluded path that is `/`
 * itself or starts with `~/`.
 */
export function csrf<C = unknown>(configure?: HTTPPluginConfigurer<CSRFBuilder, C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new CSRFBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written.
    const { label, options } = builder[kBuild]()

    return new CSRFProtection(label === 'default' ? 'caffeine-csrf' : `caffeine-csrf:${label}`, options)
  }
}

/** Where a route keeps the `exclude(...)` list of every enabled `csrf()` covering it, outermost first. */
const kCSRFCovers: unique symbol = Symbol('caffeine.http.csrf.covers')

declare module '../routing/options.js' {
  interface RouteOptions {
    /** Written by every enabled `csrf()` covering the route in `onRoute`, for the route inventory. */
    [kCSRFCovers]?: ReadonlyArray<readonly LiteralPrefix[]>
  }
}

/** The `exclude(...)` list of every enabled `csrf()` covering `route`, outermost first; empty when none does. */
export function csrfCoversOf(route: RouteDefinition): ReadonlyArray<readonly LiteralPrefix[]> {
  return route.options[kCSRFCovers] ?? []
}

class CSRFProtection extends HTTPPlugin {
  override readonly name: string
  readonly #options: CSRFOptions

  constructor(name: string, options: CSRFOptions) {
    super()
    this.name = name
    this.#options = options
  }

  register(context: HTTPSetupContext): void {
    const options = this.#options
    if (!options.enabled) {
      context.logger.warn({ plugin: this.name }, 'Cross-origin protection is turned off')
      return
    }

    const asks = options.originChecks.length > 0 || options.siteChecks.length > 0
    const exempt = new WeakSet<RouteDefinition>()

    context.server.hook('onRoute', route => {
      route.options[kCSRFCovers] = [...(route.options[kCSRFCovers] ?? []), options.exclude]

      // A route's own mark is the more specific word: `csrfExempt(false)` keeps it under an excluded prefix.
      const mark = route.options.csrf?.exempt
      if (mark === true || (mark === undefined && isExcluded(route.url, options.exclude))) {
        exempt.add(route)
      }
    })

    context.server.hook('onRequest', ctx => {
      const route = ctx.route
      if (SAFE_METHODS.has(ctx.req.method) || route === undefined || exempt.has(route)) {
        return
      }

      const input: OriginCheckInput = {
        method: ctx.req.method,
        secFetchSite: ctx.req.header('sec-fetch-site'),
        origin: ctx.req.header('origin'),
        host: ctx.req.host,
        protocol: ctx.req.protocol,
      }
      const { verdict, reason, askable } = checkOrigin(input, options)
      if (verdict !== 'deny') {
        return
      }

      const refuse = (): ErrCSRFCrossOrigin => {
        context.logger.warn(
          {
            reqId: ctx.req.id,
            reason,
            method: input.method,
            path: ctx.req.path,
            host: input.host,
            origin: input.origin,
            secFetchSite: input.secFetchSite,
          },
          'Cross-origin request refused',
        )
        return new ErrCSRFCrossOrigin(reason)
      }

      if (!asks || askable === undefined) {
        throw refuse()
      }

      const questions = questionsOf(ctx, askable, options)

      // Only `true` lets the request through; a throw or a rejection fails it.
      return (async () => {
        for (const question of questions) {
          if ((await question()) === true) {
            return
          }
        }

        throw refuse()
      })()
    })
  }
}
