import { describe, expect, it } from 'vitest'

import { InlineConfigSource } from '../../sources/inline_source.js'
import type { ConfigSource } from '../../types.js'

describe('InlineConfigSource', () => {
  it('contributes its object as one layer, named after the source', () => {
    expect(new InlineConfigSource({ a: 1 }).load()).toEqual([{ name: 'inline', data: { a: 1 } }])
    expect(new InlineConfigSource({ a: 1 }, 'fixtures').load()[0].name).toBe('fixtures')
  })

  it('is static', () => {
    const source: ConfigSource = new InlineConfigSource({})

    expect(source.live).toBeUndefined()
    expect(source.watch).toBeUndefined()
  })
})
