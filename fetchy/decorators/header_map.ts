import { appendHeaders } from '../headers_util.js'
import { classMeta, methodMeta } from '../metadata.js'
import { classOrMethod } from './_decorator_util.js'

/**
 * Appends a set of default headers, usable at class level (applies to every method) or method
 * level (applies to that method only).
 */
export function HeaderMap(headers: Record<string, string>) {
  return classOrMethod(
    'HeaderMap',
    (_target, context) => appendHeaders(classMeta(context.metadata).headers, headers),
    context => appendHeaders(methodMeta(context.metadata, context.name).headers, headers),
  )
}
