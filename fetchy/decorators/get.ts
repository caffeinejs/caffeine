import { describeRequest } from './registrar/registrar.js'

export function GET(path: string) {
  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    describeRequest(context, spec => spec.method('get').path(path))
  }
}
