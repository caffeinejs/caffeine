import { classMeta, methodMeta } from '../metadata.js'
import { classOrMethod } from './_decorator_util.js'

export function ContentType(value: string) {
  return classOrMethod(
    'ContentType',
    (_target, context) => classMeta(context.metadata).headers.append('content-type', value),
    context => methodMeta(context.metadata, context.name).headers.append('content-type', value),
  )
}
