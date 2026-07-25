import { ErrFetchyClientNotBuilt, ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureMethod } from './registrar/registrar.js'

type DecoratedMethod = (...args: any[]) => any

function decorateVerb(httpMethod: string, path: string) {
  return function <T extends DecoratedMethod>(_value: T, context: ClassMethodDecoratorContext): T {
    if (context.kind !== 'method') {
      throw new ErrFetchyInvalidDecoratorTarget(httpMethod, 'a method')
    }

    const name = String(context.name)
    const builder = configureMethod(context, spec => spec.httpMethod(httpMethod).path(path))

    return function (this: unknown, ...args: unknown[]) {
      if (!builder.invoker) {
        throw new ErrFetchyClientNotBuilt(name)
      }

      return builder.invoker(...args)
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
