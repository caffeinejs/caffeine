import type { HTTPPickers } from '../routing/picker.js'
import { type Picks, resolveParams } from './_params.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Declares how a route handler's arguments are picked from the request.
 *
 * Two signatures:
 * - an array of pickers built with the exported `$p` — `@Args([$p.query(), $p.header()])`;
 * - a builder function that receives the builtin pickers, so no `$p` import is needed —
 *   `@Args(p => [p.query(), p.header()])`.
 */
export function Args(params: Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function Args(build: (p: HTTPPickers) => Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function Args(arg: Picks | ((p: HTTPPickers) => Picks)) {
  const params = resolveParams(arg)

  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.parameters(params))
  }
}
