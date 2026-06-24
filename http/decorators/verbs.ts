import { configureRoute } from './_registrar.js'

export function Get(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'get')
  }
}

export function Post(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'post')
  }
}

export function Put(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'put')
  }
}

export function Delete(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'delete')
  }
}

export function Patch(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'patch')
  }
}

export function Head(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'head')
  }
}

export function Options(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'options')
  }
}

export function Trace(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureMethod(context, path, 'trace')
  }
}

export function Method(method: string | string[]) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.method(method))
  }
}

function configureMethod(
  context: ClassMethodDecoratorContext,
  path: string,
  method: string | string[],
) {
  configureRoute(context, spec => spec
    .method(method)
    .handler(context.name)
    .path(path))
}
