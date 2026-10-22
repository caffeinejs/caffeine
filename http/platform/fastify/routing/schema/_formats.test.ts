import { $t, compileValidator } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { registerRouteFormat } from './_formats.js'

describe('registerRouteFormat', () => {
  // Configuration and messages are validated outside any request, where no server's Ajv can answer for a route's
  // format: it refuses, as TypeBox refuses a format nobody registered.
  it('refuses every value checked outside a request', () => {
    registerRouteFormat('caffeine-test-route-format')

    expect(compileValidator($t.String({ format: 'caffeine-test-route-format' }))('anything')).toEqual({
      ok: false,
      issues: [
        { path: '', message: "Expected string to match 'caffeine-test-route-format' format", code: expect.any(String) },
      ],
    })
  })
})
