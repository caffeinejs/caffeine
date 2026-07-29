import { ErrConfigValidation } from '../errors.js'
import type { ConfigSchema } from '../schema.js'
import type { SchemaIssue } from '../types.js'

interface ZodLike<T> {
  parse(input: unknown): T
  safeParse(input: unknown): { success: true, data: T } | { success: false, error: ZodErrorLike }
}

interface ZodErrorLike {
  issues: Array<{
    path: Array<string | number>
    message: string
    code: string
  }>
}

export function schemaFromZod<T>(id: string, zodSchema: ZodLike<T>): ConfigSchema<T> {
  return {
    id,
    parse(input: unknown): T {
      const result = zodSchema.safeParse(input)

      if (result.success) {
        return result.data
      }

      const issues: SchemaIssue[] = result.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }))

      throw new ErrConfigValidation(issues)
    },
  }
}
