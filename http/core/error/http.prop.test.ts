import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { ErrHTTP } from './http.js'
import type { ProblemIssue } from './problem.js'

/**
 * What `ErrHTTP.builder()` sends as `errors`, over any sequence of calls, checked against the builder's contract
 * rather than how it stores them: `.errors()` adds after what is there, `.options({ errors })` replaces it, and an
 * empty list is left out.
 */

const issue: fc.Arbitrary<ProblemIssue> = fc.record(
  {
    code: fc.string(),
    detail: fc.string(),
    source: fc.oneof(
      fc.record({ in: fc.constant('body' as const), pointer: fc.string() }),
      fc.record(
        { in: fc.constantFrom('query', 'path', 'header', 'cookie'), name: fc.string(), pointer: fc.string() },
        { requiredKeys: ['in'] },
      ),
    ),
    params: fc.dictionary(fc.string(), fc.jsonValue()),
  },
  { requiredKeys: ['code', 'detail'] },
)

const step = fc.record({
  kind: fc.constantFrom('errors', 'options'),
  issues: fc.array(issue, { maxLength: 4 }),
})

describe('ErrHTTP.builder errors (property)', () => {
  it.prop([fc.array(step, { maxLength: 8 }), fc.option(fc.array(issue, { maxLength: 2 }), { nil: undefined })])(
    'sends what was collected since the last options() call, in order, whatever an extension claims',
    (steps, forged) => {
      const builder = ErrHTTP.builder().statusCode(422)
      let collected: ProblemIssue[] = []

      for (const { kind, issues } of steps) {
        if (kind === 'errors') {
          builder.errors(...issues)
          collected = [...collected, ...issues]
        } else {
          builder.options({ errors: issues })
          collected = issues
        }
      }
      if (forged !== undefined) {
        builder.extension('errors', forged)
      }

      const problem = builder.build().toProblem()

      if (collected.length === 0) {
        expect(problem).not.toHaveProperty('errors')
      } else {
        expect(problem.errors).toEqual(collected)
      }
    },
  )
})
