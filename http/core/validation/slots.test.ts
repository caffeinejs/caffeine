import { $t } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { applySlotPolicy, lowerCaseHeaders } from './slots.js'

describe('applySlotPolicy', () => {
  it('closes a body object in a copy and leaves the original open', () => {
    const schema = $t.Object({ a: $t.String() })
    const result = applySlotPolicy(schema, 'body')

    expect(result).not.toBe(schema)
    expect(result.additionalProperties).toBe(false)
    expect('additionalProperties' in schema).toBe(false)
  })

  it('opens a headers object so undeclared headers survive', () => {
    expect(applySlotPolicy($t.Object({ a: $t.String() }), 'headers').additionalProperties).toBe(true)
  })

  it('honours an additionalProperties the author wrote', () => {
    const schema = $t.Object({ a: $t.String() }, { additionalProperties: true })

    expect(applySlotPolicy(schema, 'body').additionalProperties).toBe(true)
  })

  it.each(['querystring', 'params'] as const)('returns the %s schema as authored', slot => {
    const schema = $t.Object({ a: $t.String() })

    expect(applySlotPolicy(schema, slot)).toBe(schema)
  })
})

describe('lowerCaseHeaders', () => {
  it('lower-cases the property and the required name', () => {
    const result = lowerCaseHeaders($t.Object({ 'X-Page': $t.Number() }))

    expect(Object.keys(result.properties)).toEqual(['x-page'])
    expect(result.required).toEqual(['x-page'])
  })

  it('lower-cases the members of a union', () => {
    const result = lowerCaseHeaders($t.Union([$t.Object({ 'X-A': $t.String() }), $t.Object({ 'X-B': $t.String() })]))
    const members = result.anyOf as { properties: object; required: string[] }[]

    expect(members.map(member => Object.keys(member.properties))).toEqual([['x-a'], ['x-b']])
    expect(members.map(member => member.required)).toEqual([['x-a'], ['x-b']])
  })

  it('lower-cases the members of a plain oneOf object', () => {
    const result = lowerCaseHeaders({
      oneOf: [{ type: 'object', properties: { 'X-A': {} }, required: ['X-A'] }],
    })

    expect(result).toEqual({
      oneOf: [{ type: 'object', properties: { 'x-a': {} }, required: ['x-a'] }],
    })
  })
})
