import type { AnyRouteExtension } from '../routing/extension.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

type EncodingToken = 'zstd' | 'br' | 'deflate' | 'gzip' | 'identity'

/** The request content encodings the route decompresses. */
export function encoding(encodings: EncodingToken | EncodingToken[]): AnyRouteExtension {
  const requestEncodings = Array.isArray(encodings) ? encodings : [encodings]

  return (target: { options(key: string, value: unknown): unknown }) => {
    target.options('decompress', { requestEncodings })
  }
}

/**
 * The request content encodings a controller or a single route decompresses.
 *
 * The programmatic form is {@link encoding}.
 */
export function Encoding(encodings: EncodingToken | EncodingToken[]) {
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouteGroup(context, fn, encoding(encodings))
    } else {
      configureRoute(context, encoding(encodings))
    }
  }
}
