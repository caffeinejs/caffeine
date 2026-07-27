import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMember } from './_decorator_util.js'

export function ContentType(value: string) {
  return classOrMember(
    'ContentType',
    (_target, context) => configureClass(context, spec => spec.header('content-type', value)),
    context => configureMethod(context, spec => spec.header('content-type', value)),
  )
}
