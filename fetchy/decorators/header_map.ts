import { configureClass, configureMethod } from './registrar/registrar.js'
import { classOrMethod } from './_decorator_util.js'

/**
 * Appends a set of default headers, usable at class level (applies to every method) or method
 * level (applies to that method only).
 */
export function HeaderMap(headers: Record<string, string>) {
  return classOrMethod(
    'HeaderMap',
    (_target, context) => configureClass(context, spec => {
      for (const [name, value] of Object.entries(headers)) {
        spec.header(name, value)
      }
    }),
    context => configureMethod(context, spec => {
      for (const [name, value] of Object.entries(headers)) {
        spec.header(name, value)
      }
    }),
  )
}
