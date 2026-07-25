import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMethod } from './_decorator_util.js'

export function ContentType(value: string) {
  return classOrMethod(
    'ContentType',
    (_target, context) => configureClass(context, spec => spec.header('content-type', value)),
    context => configureMethod(context, spec => spec.header('content-type', value)),
  )
}
