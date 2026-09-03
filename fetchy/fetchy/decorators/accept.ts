import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

export function Accept(value: string) {
  return classOrMember(
    'Accept',
    (_target, context) => configureClass(context, spec => spec.header('accept', value)),
    context => configureMethod(context, spec => spec.header('accept', value)),
  )
}
