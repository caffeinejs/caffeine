import { ErrFetchyClientNotBuilt, ErrFetchyInvalidDecoratorTarget, ErrFetchyInvalidRoute } from '../errors.js'
import type { Invoker } from '../service_invoker.js'
import { configureMethod } from './registrar/registrar.js'

type Dispatch = (this: unknown, ...args: unknown[]) => unknown

function decorateVerb(httpMethod: string, path: string) {
  // Return type deliberately `any`: this must satisfy both the method decorator return type
  // (`void | Method`) and the field decorator return type (`void | Initializer`) at each use
  // site, and no single concrete type (including `unknown`) is assignable to both at once.
  return function (_value: unknown, context: ClassMethodDecoratorContext | ClassFieldDecoratorContext): any {
    if ((context.kind !== 'method' && context.kind !== 'field') || context.static) {
      throw new ErrFetchyInvalidDecoratorTarget(httpMethod, 'an instance method or field')
    }

    const name = String(context.name)
    const { key } = configureMethod(context, spec => {
      const declared = spec.toMethodSpec().httpMethod

      if (declared) {
        throw new ErrFetchyInvalidRoute(name, `more than one HTTP verb decorator ("${declared}" and "${httpMethod}")`)
      }

      spec.httpMethod(httpMethod).path(path)
    })

    // `create()` stores each client's invoker on the client under `key`. A method becomes one prototype function
    // shared by every client, which finds the invoker through `this`, so a subclass's `super` call reaches the base
    // class's operation. Method shorthand cannot be constructed and takes the member's name.
    if (context.kind === 'method') {
      return (
        {
          [context.name](this: unknown, ...args: unknown[]): unknown {
            const invoke = (this as Partial<Record<symbol, Invoker>> | null | undefined)?.[key]

            if (invoke === undefined) {
              throw new ErrFetchyClientNotBuilt(name)
            }

            return invoke(args)
          },
        } as Record<string | symbol, Dispatch>
      )[context.name]
    }

    // A field decorator returns an initializer, run with the instance as `this`. The function it returns is bound to
    // that instance, as an arrow-function field would be, so the operation still works destructured.
    return function (this: Partial<Record<symbol, Invoker>>): Dispatch {
      return (...args: unknown[]): unknown => {
        const invoke = this[key]

        if (invoke === undefined) {
          throw new ErrFetchyClientNotBuilt(name)
        }

        return invoke(args)
      }
    }
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
