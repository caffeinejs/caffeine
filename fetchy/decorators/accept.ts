import { classMeta, methodMeta } from '../metadata.js'
import { classOrMethod } from './_decorator_util.js'

export function Accept(value: string) {
  return classOrMethod(
    'Accept',
    (_target, context) => classMeta(context.metadata).headers.append('accept', value),
    context => methodMeta(context.metadata, context.name).headers.append('accept', value),
  )
}
