import {
  kBootstrap,
  kExtensionStage,
  kFeatureName,
  type BootstrapKit,
  type ExtensionStage,
  type FeatureLifecycle,
} from '@caffeinejs/std'

import { installFormBodyParser } from './form/index.js'
import { installNotFoundHandler, NotFoundFallback } from './not_found.js'
import { ServerExtension, type ServerExtensionContext } from './server_extension.js'

/** Teaches the server to parse `application/x-www-form-urlencoded` bodies. */
export class FormBodyExtension extends ServerExtension {
  readonly name = 'caffeine-form-body'
  readonly [kExtensionStage]: ExtensionStage = 'core'

  configure(ctx: ServerExtensionContext): void {
    installFormBodyParser(ctx.server)
  }
}

/**
 * Installs the root not-found handler, and the {@link NotFoundFallback} chain in front of it.
 *
 * `fallback`, so it runs after every other extension has registered. A fallback serving files needs the
 * `reply.sendFile` that `@fastify/static` decorates while it registers, and one deriving the paths the server
 * owns needs every route and every {@link ServerOwnedPaths} provider already in place.
 */
export class NotFoundExtension extends ServerExtension {
  readonly name = 'caffeine-not-found'
  readonly [kExtensionStage]: ExtensionStage = 'fallback'

  configure(ctx: ServerExtensionContext): void {
    installNotFoundHandler(ctx, ctx.container.getManyOptional<NotFoundFallback>(NotFoundFallback))
  }
}

/**
 * The wiring `http` itself contributes, expressed the way any other feature contributes its own.
 *
 * There is nothing pluggable here — these extensions are this package's own code — but they go through the
 * public registry rather than being hardcoded in the adapter, so a package outside `http` can be ordered
 * against them and the adapter has one registration path instead of two.
 */
export class HTTPCoreFeature implements FeatureLifecycle {
  get [kFeatureName](): string {
    return 'http-core'
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    kit.extensions.register(FormBodyExtension, new FormBodyExtension())
    kit.extensions.register(NotFoundExtension, new NotFoundExtension())

    return Promise.resolve()
  }
}
