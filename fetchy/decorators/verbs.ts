import { ErrFetchyClientNotBuilt, ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { normalizePath } from '../internal/path_util.js'
import { methodMeta } from '../metadata.js'

type DecoratedMethod = (...args: any[]) => any

function decorateVerb(httpMethod: string, path: string) {
  return function <T extends DecoratedMethod>(_value: T, context: ClassMethodDecoratorContext): T {
    if (context.kind !== 'method') {
      throw new ErrFetchyInvalidDecoratorTarget(httpMethod, 'a method')
    }

    const name = String(context.name)
    const meta = methodMeta(context.metadata, context.name)
    meta.httpMethod = httpMethod
    meta.path = normalizePath(path)

    return function (this: unknown, ...args: unknown[]) {
      if (!meta.invoker) {
        throw new ErrFetchyClientNotBuilt(name)
      }

      return meta.invoker(...args)
    } as T
  }
}

export function GET(path = '') {
  return decorateVerb('GET', path)
}

export function POST(path = '') {
  return decorateVerb('POST', path)
}

export function PUT(path = '') {
  return decorateVerb('PUT', path)
}

export function DELETE(path = '') {
  return decorateVerb('DELETE', path)
}

export function PATCH(path = '') {
  return decorateVerb('PATCH', path)
}

export function HEAD(path = '') {
  return decorateVerb('HEAD', path)
}

export function OPTIONS(path = '') {
  return decorateVerb('OPTIONS', path)
}

export function HTTP(httpMethod: string, path = '') {
  return decorateVerb(httpMethod.toUpperCase(), path)
}
