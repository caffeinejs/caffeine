import type { RouteValidationSchema } from '../core/routing/spec.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Declares the validation contract of a route. Each slot takes a `$t` schema (recommended) or any Standard Schema
 * (one for a response must convert to JSON Schema), and is compiled once, when the route is registered. A `$t` slot is
 * compiled by the server's `schemaCompiler` (TypeBox by default) and its codecs, such as `$t.Duration()`, are decoded;
 * a Standard Schema slot is validated by its own library. A response schema writes declared members only, its codecs
 * encoded first, so `$t.Duration()` sends `"5s"`; a string the handler returns is sent as it is.
 *
 * ```ts
 * @Post('/')
 * @Schema({ body: CreatePet, response: { 201: PetDTO } })
 * @Args([$p.body()])
 * create(dto: InferSchema<typeof CreatePet>) { ... }
 * ```
 */
export function Schema<S extends RouteValidationSchema>(schema: S) {
  return function (_target: Function, context: ClassMemberDecoratorContext): void {
    configureRoute(context, spec => spec.schema(schema))
  }
}
