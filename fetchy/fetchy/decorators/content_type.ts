import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

export function ContentType(value: string) {
  return classOrMember(
    'ContentType',
    (_target, context) => configureClass(context, spec => spec.header('content-type', value)),
    context => configureMethod(context, spec => spec.header('content-type', value)),
  )
}
