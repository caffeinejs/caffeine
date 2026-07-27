import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMember } from './_decorator_util.js'

export function Accept(value: string) {
  return classOrMember(
    'Accept',
    (_target, context) => configureClass(context, spec => spec.header('accept', value)),
    context => configureMethod(context, spec => spec.header('accept', value)),
  )
}
