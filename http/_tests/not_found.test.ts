import { describe, expect, it } from 'vitest'

import { Controller, ErrHTTPNotFound, Get, type ActionResult } from '../index.js'
import { createWebApplication } from '../platform/node/index.js'

@Controller('/pets')
class PetsController {
  @Get('/:id')
  byID(): ActionResult {
    throw new ErrHTTPNotFound('Pet not found')
  }

  @Get('/ok')
  ok(): ActionResult {
    return { ok: true }
  }
}
void [PetsController]

describe('unmatched routes', () => {
  it('renders the same problem as a 404 a handler threw', async () => {
    const app = createWebApplication()
    await app.bootstrap()

    const thrown = (await (await app.request('/pets/42')).json()) as Record<string, unknown>
    const unmatched = (await (await app.request('/no-such-route')).json()) as Record<string, unknown>

    // Same keys, same values — only the detail differs.
    expect(Object.keys(unmatched).sort()).toEqual(Object.keys(thrown).sort())
    expect(unmatched.status).toBe(404)
    expect(unmatched.title).toBe('Not Found')
    expect(unmatched.code).toBe('ERR_HTTP_NOT_FOUND')
    expect(unmatched.detail).toBe('Route GET:/no-such-route not found')

    await app.close()
  })
})
