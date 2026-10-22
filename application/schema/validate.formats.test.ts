import { describe, expect, it } from 'vitest'

import { $t } from './t.js'
import { validateSchema } from './validate.js'

// In a file of its own, so that no earlier validation in the same file has taught TypeBox the formats first.
describe('validateSchema with a string format', () => {
  // TypeBox refuses every value of a format it does not know, so a configuration value with a `format` failed always.
  it("checks the format as Fastify's Ajv does", () => {
    const schema = $t.Object({ email: $t.String({ format: 'email' }) })

    expect(validateSchema(schema, { email: 'ops@example.com' })).toEqual({
      ok: true,
      value: { email: 'ops@example.com' },
    })
    expect(validateSchema(schema, { email: 'ops' }).ok).toBe(false)
  })
})
