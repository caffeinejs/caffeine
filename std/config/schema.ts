import { ErrConfigValidation } from './errors.js'
import type { SchemaIssue } from './types.js'

export interface ConfigSchema<T> {
  readonly id: string
  parse(input: unknown): T
}

export function validateConfig<T>(schema: ConfigSchema<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch (err) {
    if (err instanceof ErrConfigValidation) {
      throw err
    }

    const issues: SchemaIssue[] = extractIssues(err)
    throw new ErrConfigValidation(issues, err)
  }
}

function extractIssues(err: unknown): SchemaIssue[] {
  if (err && typeof err === 'object') {
    if ('issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
      return (err as { issues: unknown[] }).issues.map(i => {
        const issue = i as Record<string, unknown>
        return {
          path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? ''),
          message: String(issue.message ?? 'Invalid value'),
          code: issue.code !== undefined ? String(issue.code) : undefined,
        }
      })
    }

    if ('message' in err) {
      return [{ path: '', message: String((err as { message: unknown }).message) }]
    }
  }

  return [{ path: '', message: String(err) }]
}
