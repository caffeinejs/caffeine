import type { RouteValidationSchema } from '../route.js'
import { configureRoute } from './registrar/registrar.js'

/**
 * Declares the validation contract of a route. Each slot takes a `$t` schema (recommended) or any Standard Schema
 * that converts to JSON Schema; the schema is compiled once, when the route is registered, and Fastify's Ajv
 * validates every request from the compiled result.
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
