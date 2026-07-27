import { ErrFetchyClientNotBuilt, ErrFetchyInvalidDecoratorTarget } from '../errors.js'
import { configureMethod } from './registrar/registrar.js'

function decorateVerb(httpMethod: string, path: string) {
  // Return type deliberately `any`: this must satisfy both the method decorator return type
  // (`void | Method`) and the field decorator return type (`void | Initializer`) at each use
  // site, and no single concrete type (including `unknown`) is assignable to both at once.
  return function (
    _value: unknown,
    context: ClassMethodDecoratorContext | ClassFieldDecoratorContext,
  ): any {
    if (context.kind !== 'method' && context.kind !== 'field') {
      throw new ErrFetchyInvalidDecoratorTarget(httpMethod, 'a method or field')
    }

    const name = String(context.name)
    configureMethod(context, spec => spec.httpMethod(httpMethod).path(path))

    const stub = (): never => {
      throw new ErrFetchyClientNotBuilt(name)
    }

    // Field decorators return an *initializer* (called at construction time with the field's
    // current value) rather than the value itself — methods get the stand-in directly.
    return context.kind === 'field' ? () => stub : stub
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
