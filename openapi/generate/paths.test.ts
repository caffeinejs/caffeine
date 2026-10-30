import { describe, expect, it } from 'vitest'

import { translatePath } from './paths.js'

describe('translatePath', () => {
  // Without the optional segment a root route is "/", never the empty string, which is not a valid path key.
  it('turns an optional parameter at the root into the root path and the parameterized one', () => {
    expect(translatePath('/:id?')).toEqual({
      templates: ['/', '/{id}'],
      parameters: [{ name: 'id', pattern: undefined }],
    })
  })
})
