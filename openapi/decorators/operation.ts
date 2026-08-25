import { configureRoute } from '@caffeinejs/http/decorators/registrar'
import type { OperationDetail } from './detail.js'
import { kOperation } from './keys.js'

/**
 * Documents a route: the prose, the operationId, and any response detail the schema cannot carry.
 *
 * Only what routing and JSON Schema cannot state belongs here. Parameters come from `@Schema` and the `$p`
 * pickers, the request body from `@Schema({ body })`, the response bodies from `@Schema({ response })`, the
 * success status from `@Status`, and the security requirement from `@Authorize` / `@Roles` — the generator
 * reads all of those directly, and anything set here is merged *over* them.
 *
 * ```ts
 * @Get('/:id')
 * @Schema({ params: petIdParamSchema, response: { 200: petSchema, 404: apiErrorSchema } })
 * @Operation({
 *   summary: 'Get a pet by ID',
 *   operationId: 'getPet',
 *   responses: { 404: { description: 'No pet with that ID' } },
 * })
 * get(id: string) { ... }
 * ```
 */
export function Operation(detail: OperationDetail) {
  return function (_target: unknown, context: ClassMethodDecoratorContext): void {
    configureRoute(context, spec => spec.extras(kOperation, detail))
  }
}
