import type { HTTPPickers } from '../route_picker.js'
import { type Picks, resolveParams } from './_params.js'
import { configureRoute } from './registrar/registrar.js'

type MethodDecorator = (target: Function, context: ClassMethodDecoratorContext) => void

function createMethodDecorator(method: string) {
  function decorator(path: string): MethodDecorator
  function decorator(path: string, params: Picks): MethodDecorator
  function decorator(path: string, build: (p: HTTPPickers) => Picks): MethodDecorator
  function decorator(path: string, arg?: Picks | ((p: HTTPPickers) => Picks)): MethodDecorator {
    const params = arg === undefined ? undefined : resolveParams(arg)

    return function (_target: Function, context: ClassMethodDecoratorContext): void {
      configureMethod(context, path, method, params)
    }
  }

  return decorator
}

export const Get = createMethodDecorator('get')
export const Post = createMethodDecorator('post')
export const Put = createMethodDecorator('put')
export const Delete = createMethodDecorator('delete')
export const Patch = createMethodDecorator('patch')
export const Head = createMethodDecorator('head')
export const Options = createMethodDecorator('options')
export const Trace = createMethodDecorator('trace')
export const Query = createMethodDecorator('query')

export function Method(method: string | string[]) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.method(method))
  }
}

function configureMethod(
  context: ClassMethodDecoratorContext,
  path: string,
  method: string | string[],
  params?: Picks,
) {
  configureRoute(context, spec => {
    spec.method(method).name(context.name).path(path)
    if (params !== undefined) {
      spec.parameters(params)
    }
  })
}
