import { configureRoute, configureRouter } from './registrar/registrar.js'

type EncodingToken = 'zstd' | 'br' | 'deflate' | 'gzip' | 'identity'

export function Encoding(encodings: EncodingToken | EncodingToken[]) {
  const requestEncodings = Array.isArray(encodings) ? encodings : [encodings]
  return (fn: Function, context: ClassDecoratorContext | ClassMemberDecoratorContext): void => {
    if (context.kind === 'class') {
      configureRouter(context, fn, spec => spec.options('decompress', { requestEncodings }))
    } else {
      configureRoute(context, spec => spec.options('decompress', { requestEncodings }))
    }
  }
}
