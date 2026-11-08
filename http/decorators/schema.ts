import type { RouteValidationSchema } from '../core/routing/spec.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Declares the validation contract of a route. Each slot takes a `$t` schema (recommended) or any Standard Schema, and
 * the schema is compiled once, when the route is registered. Fastify's Ajv validates the request, unless a slot holds
 * a codec such as `$t.Duration()` or a Standard Schema: then Caffeine validates it, decoding the codecs and running
 * the library.
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
