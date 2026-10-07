import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import type { HTTPPluginConfigurer, HTTPPluginFactory } from '../plugin.js'
import { protocolOf } from '../protocol.js'
import { ErrCSRFCrossOrigin } from './errors.js'
import { isExcluded, resolveCSRFOptions, type CSRFConfig, type CSRFOptions } from './options.js'
import { checkOrigin, SAFE_METHODS, type OriginCheckInput } from './origin.js'
import { isCSRFExempt } from './route.js'

const kBuild = Symbol('caffeine.http.csrf.build')

/**
 * Authors one `csrf()` plugin's settings. The callback runs while the factory builds the plugin, handed the same
 * `HTTPSetupContext` the factory gets, so a setting can come from the configuration.
 *
 * What a fluent method sets is final: `trustedOrigins(...)` or `exclude(...)` written here replaces what the node
 * handed to {@link config} carries.
 */
export class CSRFBuilder {
  #label = 'default'
  #config: CSRFConfig | undefined
  #enabled: boolean | undefined
  #trustedOrigins: string[] | undefined
  #exclude: string[] | undefined

  /**
   * Reads the settings from a node of the configuration tree, e.g. `config.app.csrf`. The node is read once, when
   * the plugin is built. A fluent method called alongside wins over what the node carries.
   */
  config(config: CSRFConfig): this {
    this.#config = config
    return this
  }

  /** Turns the check off, which registers nothing: for an environment where every client is a non-browser. */
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
    ;(this.#trustedOrigins ??= []).push(...origins)
    return this
  }

  /**
   * Registered route paths the check leaves alone, each a prefix of whole segments: `/webhooks` covers `/webhooks`
   * and `/webhooks/stripe`, not `/webhooks-old`. Judged by the path a route was registered under, never the URL
   * requested. For a route the application cannot mark itself; its own are marked with `@CSRFExempt()`,
   * `csrfExempt()` or `csrfExemptConfig()`.
   *
   * @throws ErrCSRFConfiguration at start-up when one does not start with `/`.
   */
  exclude(...prefixes: string[]): this {
    ;(this.#exclude ??= []).push(...prefixes)
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
      options: resolveCSRFOptions({
        enabled: this.#enabled ?? this.#config?.enabled,
        trustedOrigins: this.#trustedOrigins ?? this.#config?.trustedOrigins,
        exclude: this.#exclude ?? this.#config?.exclude,
      }),
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
 * A route is left alone when its registered path is under `.exclude(...)`, or when it is marked with
 * `@CSRFExempt()`, `csrfExempt()` or `csrfExemptConfig()`. A URL no route matched is the not-found handler's. An ops
 * server is covered by its own `Ops(name, o => o.with(csrf()))`, a route group by
 * `router.plugin(csrf(c => c.name('admin')))`.
 *
 * @throws ErrCSRFConfiguration at start-up for a trusted origin that is not one, or an excluded path not starting
 * with `/`.
 */
export function csrf<C = unknown>(configure?: HTTPPluginConfigurer<CSRFBuilder, C>): HTTPPluginFactory<C> {
  return context => {
    const builder = new CSRFBuilder()
    configure?.(builder, context)

    // Resolved as the factory runs: a bad setting fails start-up where it was written, not inside Fastify.
    const { label, options } = builder[kBuild]()

    const plugin: FastifyPluginAsync = async instance => {
      if (!options.enabled) {
        return
      }

      // Callback style, not `async`: nothing here awaits, and a hand-written Fastify hook is shaped this way.
      instance.addHook('onRequest', (request, _reply, done) => {
        if (SAFE_METHODS.has(request.method) || request.is404) {
          done()
          return
        }

        const route = request.routeOptions
        if (isExcluded(route.url ?? '', options.exclude) || isCSRFExempt(route.config)) {
          done()
          return
        }

        const input = inputOf(request)
        const { verdict, reason } = checkOrigin(input, options)
        if (verdict !== 'deny') {
          done()
          return
        }

        request.log.warn(
          {
            reason,
            method: input.method,
            url: request.url,
            host: input.host,
            origin: input.origin,
            secFetchSite: input.secFetchSite,
          },
          'Cross-origin request refused',
        )
        done(new ErrCSRFCrossOrigin(reason))
      })
    }

    return fp(plugin, { name: label === 'default' ? 'caffeine-csrf' : `caffeine-csrf:${label}` })
  }
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
