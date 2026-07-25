import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMethod } from './_decorator_util.js'

export function Accept(value: string) {
  return classOrMethod(
    'Accept',
    (_target, context) => configureClass(context, spec => spec.header('accept', value)),
    context => configureMethod(context, spec => spec.header('accept', value)),
  )
}
