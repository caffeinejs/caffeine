import { expect, it } from 'vitest'

import { compileMultipartDeclaration } from './multipart.js'

it('propagates the original error when a route cannot supply its subtype', () => {
  const cause = new Error('Route policy unavailable')
  const declaration = {
    get subtype(): string {
      throw cause
    },
  }

  expect(() => compileMultipartDeclaration(declaration, [], 'upload')).toThrow(
    expect.toSatisfy((error: unknown) => error === cause),
  )
})
