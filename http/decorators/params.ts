import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import { $p, type HTTPPickers } from '../route_picker.js'
import { configureRoute } from './registrar/registrar.js'

type Picks = ParameterPickOptions<unknown>[]

/**
 * Declares how a route handler's arguments are picked from the request.
 *
 * Two signatures:
 * - an array of pickers built with the exported `$p` — `@Params([$p.query(), $p.header()])`;
 * - a builder function that receives the builtin pickers, so no `$p` import is needed —
 *   `@Params(p => [p.query(), p.header()])`.
 */
export function Params(params: Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function Params(build: (p: HTTPPickers) => Picks): (target: Function, ctx: ClassMethodDecoratorContext) => void
export function Params(arg: Picks | ((p: HTTPPickers) => Picks)) {
  const params = typeof arg === 'function' ? arg($p) : arg

  return function (_target: Function, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.parameters(params))
  }
}
