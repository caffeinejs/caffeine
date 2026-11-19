import { expect, it } from 'vitest'

import { normalizeMultipartInput } from './multipart.js'

it('rejects misplaced limits so an intended route restriction cannot silently be ignored', () => {
  const declaration = { subtype: 'form-data', maxFiles: 0 }
  expect(() => normalizeMultipartInput(declaration)).toThrow(
    'A multipart input needs a subtype and accepts only optional limits',
  )
})
