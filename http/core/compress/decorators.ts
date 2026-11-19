import { configureRoute, configureRouteGroup } from '../../decorators/registrar/registrar.js'
import type { AnyRouteExtension } from '../routing/extension.js'
import { compress, type CompressionConfig, type ContentCoding } from './compress.js'
import { decompress } from './decompression.js'

/**
 * Sets a route's compression, or every route's of a controller, over `compression()`'s, member by member: `false`
 * turns it off, `true` keeps the plugin's settings.
 *
 * On a controller it sets every method, one added later included; on a method it decides for that method whatever the
 * controller declared. It needs `compression()` over the route. The programmatic form is {@link compress}.
 */
export function Compress(options: CompressionConfig | boolean) {
  return decorator(compress(options))
}

/**
 * Compresses the route, or every route of a controller, with gzip alone: identity for a client that does not accept
 * it. The plugin's other settings stay; `options` sets gzip's level, 1 to 9.
 *
 * One coding decorator per method: for several, write `@Compress({ encodings: [...] })`. It needs `compression()`
 * over the route.
 */
export function Gzip(options?: { level?: number }) {
  return decorator(compress(options === undefined ? { encodings: ['gzip'] } : { encodings: ['gzip'], gzip: options }))
}

/** Compresses with deflate alone; `options` sets its level, 1 to 9. See {@link Gzip}. */
export function Deflate(options?: { level?: number }) {
  return decorator(
    compress(options === undefined ? { encodings: ['deflate'] } : { encodings: ['deflate'], deflate: options }),
  )
}

/** Compresses with Brotli alone; `options` sets its quality, 0 to 11. See {@link Gzip}. */
export function Brotli(options?: { quality?: number }) {
  return decorator(compress(options === undefined ? { encodings: ['br'] } : { encodings: ['br'], br: options }))
}

/** Compresses with zstd alone; `options` sets its level, 1 to 19. See {@link Gzip}. */
export function Zstd(options?: { level?: number }) {
  return decorator(compress(options === undefined ? { encodings: ['zstd'] } : { encodings: ['zstd'], zstd: options }))
}

/**
 * The request codings a route decodes, or every route's of a controller, in place of `decompression()`'s; `false`
 * decodes none. A method's list replaces its controller's. The programmatic form is {@link decompress}.
 */
export function Decompress(encodings: ContentCoding | readonly ContentCoding[] | false) {
  return decorator(decompress(encodings))
}

function decorator(extension: AnyRouteExtension) {
  return (target: Function | object, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, target as Function, extension)
    } else {
      configureRoute(context, extension)
    }
  }
}
