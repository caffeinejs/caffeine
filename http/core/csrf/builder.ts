import {
  resolveCSRFOptions,
  type CSRFConfig,
  type CSRFOptions,
  type OriginPredicate,
  type SecFetchSitePredicate,
} from './options.js'

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
