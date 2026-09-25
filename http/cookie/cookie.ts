import { kFeatureName } from '@caffeinejs/std'
import { $t } from '@caffeinejs/std/schema'
import FastifyCookie, { type CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'

import { HTTPFeatureBuilder } from '../feature.js'

/** How the cookie feature registers `@fastify/cookie`. */
export interface CookieOptions {
  /** Whether cookies are parsed at all. Off means the plugin is not registered. */
  enabled: boolean
  /**
   * The key the plugin signs and unsigns with. An array rotates keys: the first signs, and any of them
   * verifies.
   */
  secret?: string | string[]
  /** Defaults applied to every cookie the application sets. */
  parseOptions?: CookieSerializeOptions
}

/**
 * The shape the cookie feature expects wherever the application decides to keep its settings — import it into
 * an application schema (`$t.Object({ app: $t.Object({ cookie: cookieConfigSchema }) })`) rather than
 * restating the fields, then hand that node to {@link CookieBuilder.config}.
 *
 * `parseOptions` is not part of it: a serializer's `encode` is a function, which no configuration source can
 * carry, so those defaults are set with {@link CookieBuilder.parseOptions}.
 */
export const cookieConfigSchema = $t.Object({
  enabled: $t.Boolean({ default: true }),
  secret: $t.Optional($t.String()),
})

/**
 * Configures the cookie parsing every application gets.
 *
 * The feature is registered unconditionally and ahead of everything `.with(...)` installs, so cookies are
 * parsed for every request whether or not this is ever called, and no feature reading one — the authentication
 * gate included — has an order to get right. What a call adds is what registration cannot guess: the signing
 * secret, without which `ctx.req.signedCookie()` has nothing to verify with.
 *
 * What a fluent method sets is final. To let the environment carry the secret, read it from the
 * configuration — {@link cookieConfigSchema} is exported so an application can splice it into its own schema
 * rather than restate the fields:
 *
 * ```ts
 * .cookie((k, { config }) => k.config(config.app.cookie))
 * ```
 *
 * An application whose own Fastify instance already registered `@fastify/cookie` keeps that registration and
 * its options: this feature stands down rather than registering a second time, which Fastify refuses over the
 * decorators already in place.
 */
export class CookieBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'cookie'

  #config: Partial<CookieOptions> | undefined
  #enabled: boolean | undefined
  #secret: string | string[] | undefined
  #parseOptions: CookieSerializeOptions | undefined

  /**
   * Reads the settings from a node of the configuration tree, e.g. `config.app.cookie`.
   *
   * The node is read once, when the server is wired. {@link enabled} and {@link secret} win over what the node
   * carries.
   */
  config(config: Partial<CookieOptions>): this {
    this.#config = config
    return this
  }

  /**
   * Turns cookie parsing off, which leaves the plugin unregistered: `ctx.req.cookie()` then fails rather than
   * answering `undefined`, and a scheme authenticating from a cookie authenticates nobody.
   */
  enabled(enabled: boolean): this {
    this.#enabled = enabled
    return this
  }

  secret(secret: string | string[]): this {
    this.#secret = secret
    return this
  }

  parseOptions(options: CookieSerializeOptions): this {
    this.#parseOptions = options
    return this
  }

  protected override async server(instance: FastifyInstance): Promise<void> {
    if (!(this.#enabled ?? this.#config?.enabled ?? true)) {
      return
    }

    // The application registered the plugin on its own Fastify instance, so it owns the settings — including
    // the secret, which this feature must not quietly replace. Registering again fails on the decorators.
    if (instance.hasRequestDecorator('cookies')) {
      return
    }

    const secret = this.#secret ?? this.#config?.secret
    const parseOptions = this.#parseOptions ?? this.#config?.parseOptions

    await instance.register(FastifyCookie, {
      ...(secret !== undefined && { secret }),
      ...(parseOptions !== undefined && { parseOptions }),
    })
  }
}
