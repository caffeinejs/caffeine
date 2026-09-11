import { kBootstrap, kFeatureName, type BootstrapKit, type Feature } from '@caffeinejs/std'
import fp from 'fastify-plugin'

import { constraintVaryPlugin } from './constraints/vary_plugin.js'
import { installFormBodyParser } from './form/index.js'
import { installNotFoundHandler, NotFoundFallback } from './not_found.js'
import { registerPlugin, type HTTPPlugin } from './plugin.js'

/** Teaches the server to parse `application/x-www-form-urlencoded` bodies. */
const formBodyPluginFn: HTTPPlugin = async instance => {
  installFormBodyParser(instance)
}

const formBodyPlugin = fp(formBodyPluginFn, { name: 'caffeine-form-body' })

/**
 * Installs the root not-found handler, and the {@link NotFoundFallback} chain in front of it.
 *
 * A fallback serving files needs the `reply.sendFile` that `@fastify/static` decorates while it registers,
 * and one deriving the paths the server owns needs every route and every `ServerOwnedPaths` provider already
 * in place — so the feature that contributes this is the last one the application bootstraps.
 */
const notFoundPluginFn: HTTPPlugin = async (instance, opts) => {
  installNotFoundHandler(
    { ...opts, server: instance },
    opts.container.getManyOptional<NotFoundFallback>(NotFoundFallback),
  )
}

const notFoundPlugin = fp(notFoundPluginFn, { name: 'caffeine-not-found' })

/**
 * The wiring `http` contributes ahead of everything else: the form body parser, and the `Vary` header a
 * constrained route needs. Bootstrapped first, so both are in place before any other plugin registers.
 */
export class HTTPCoreFeature implements Feature {
  get [kFeatureName](): string {
    return 'http-core'
  }

  [kBootstrap](kit: BootstrapKit): void {
    registerPlugin(kit, formBodyPlugin)
    registerPlugin(kit, constraintVaryPlugin)
  }
}

/** The wiring `http` contributes once everything else has registered: the not-found handler. */
export class HTTPFallbackFeature implements Feature {
  get [kFeatureName](): string {
    return 'http-fallback'
  }

  [kBootstrap](kit: BootstrapKit): void {
    registerPlugin(kit, notFoundPlugin)
  }
}
