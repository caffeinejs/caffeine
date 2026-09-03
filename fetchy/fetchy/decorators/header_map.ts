import { classOrMember } from './_decorator_util.js'
import { configureClass, configureMethod } from './registrar/registrar.js'

/**
 * Appends a set of default headers, usable at class level (applies to every method) or method
 * level (applies to that method only).
 */
export function HeaderMap(headers: Record<string, string>) {
  return classOrMember(
    'HeaderMap',
    (_target, context) =>
      configureClass(context, spec => {
        for (const [name, value] of Object.entries(headers)) {
          spec.header(name, value)
        }
      }),
    context =>
      configureMethod(context, spec => {
        for (const [name, value] of Object.entries(headers)) {
          spec.header(name, value)
        }
      }),
  )
}
