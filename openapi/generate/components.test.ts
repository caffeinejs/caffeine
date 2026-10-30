import { $t } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { ErrOpenAPISchemaConflict } from '../errors.js'
import { ComponentRegistry, componentName } from './components.js'

describe('ComponentRegistry', () => {
  // A consumer can only name what reaches `components.schemas`; a `$defs` entry left inside one schema is
  // invisible to every other operation that wants to reference it.
  it('hoists $defs into components and leaves the schema without them', () => {
    const registry = new ComponentRegistry()

    const schema = registry.register(
      $t.Unsafe({
        type: 'object',
        properties: { owner: { $ref: '#/$defs/Owner' } },
        $defs: { Owner: { type: 'object', properties: { name: { type: 'string' } } }, Broken: 'not a schema' },
      }),
      'output',
      'GET /pets response.200',
    )

    expect(schema).toEqual({ type: 'object', properties: { owner: { $ref: '#/$defs/Owner' } } })
    expect(registry.build()).toEqual({ Owner: { type: 'object', properties: { name: { type: 'string' } } } })
  })

  it('hoists a named schema nested in a list keyword and in a property map', () => {
    const registry = new ComponentRegistry()
    const cat = $t.Object({ meow: $t.Boolean() }, { $id: 'Cat' })
    const dog = $t.Object({ bark: $t.Boolean() }, { $id: 'Dog' })

    const schema = registry.register(
      $t.Object({ pet: $t.Union([cat, dog]), tags: $t.Array($t.String()) }),
      'output',
      'GET /pets response.200',
    )

    expect(schema.properties).toEqual({
      pet: { anyOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }] },
      tags: { type: 'array', items: { type: 'string' } },
    })
    expect(Object.keys(registry.build() ?? {})).toEqual(['Cat', 'Dog'])
  })

  // Boolean subschemas are legal JSON Schema; treating them as objects would turn `true` into `{}`.
  it('keeps non-schema values as written', () => {
    const registry = new ComponentRegistry()

    const schema = registry.register(
      $t.Unsafe({
        type: 'object',
        properties: { anything: true },
        enum: ['a', 'b'],
        allOf: [true],
        default: { anything: { $id: 'NotASchema' } },
      }),
      'input',
      'POST /pets body',
    )

    // `default` is a value, not a subschema: an `$id` inside it is data and must not be hoisted.
    expect(schema).toEqual({
      type: 'object',
      properties: { anything: true },
      enum: ['a', 'b'],
      allOf: [true],
      default: { anything: { $id: 'NotASchema' } },
    })
    expect(registry.build()).toBe(undefined)
  })

  it('accepts the same named schema twice and stores it once', () => {
    const registry = new ComponentRegistry()
    const pet = $t.Object({ id: $t.String() }, { $id: 'Pet' })

    registry.register(pet, 'output', 'GET /pets/:id response.200')
    registry.register(pet, 'output', 'GET /pets response.200')

    expect(registry.build()).toEqual({
      Pet: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
  })

  // Emitting either shape would misdescribe every route that uses the other.
  it('refuses two different schemas under one component name', () => {
    const registry = new ComponentRegistry()

    registry.register($t.Object({ id: $t.String() }, { $id: 'Pet' }), 'output', 'GET /a response.200')

    const second = () =>
      registry.register($t.Object({ id: $t.Integer() }, { $id: 'Pet' }), 'output', 'GET /b response.200')

    expect(second).toThrow(ErrOpenAPISchemaConflict)
    expect(second).toThrow('two different schemas share the component name "Pet"')
  })

  describe('with deduplication', () => {
    it('names a repeated anonymous object once and references it from every use', () => {
      const registry = new ComponentRegistry(true)
      const shape = () => $t.Object({ message: $t.String() })

      const first = registry.register(shape(), 'output', 'GET /a response.400')
      const second = registry.register(shape(), 'output', 'GET /b response.400')

      expect(first).toEqual({ $ref: '#/components/schemas/Schema1' })
      expect(second).toEqual({ $ref: '#/components/schemas/Schema1' })
      expect(Object.keys(registry.build() ?? {})).toEqual(['Schema1'])
    })

    it('numbers distinct shapes in the order they first appear', () => {
      const registry = new ComponentRegistry(true)

      registry.register($t.Object({ a: $t.String() }), 'output', 'GET /a response.200')
      const second = registry.register($t.Object({ b: $t.String() }), 'output', 'GET /b response.200')

      expect(second).toEqual({ $ref: '#/components/schemas/Schema2' })
    })

    // Hoisting `{ type: 'string' }` would produce a component per primitive and no reuse worth having.
    it('leaves primitives and property-less objects inline', () => {
      const registry = new ComponentRegistry(true)

      expect(registry.register($t.String(), 'output', 'GET /a response.200')).toEqual({ type: 'string' })
      expect(registry.register($t.Unsafe({ type: 'object' }), 'output', 'GET /b response.200')).toEqual({
        type: 'object',
      })
      expect(registry.build()).toBe(undefined)
    })
  })

  it('uses the naming function it was given, and inlines what it declines to name', () => {
    const registry = new ComponentRegistry(false, schema => (schema.$id === 'v2/Pet' ? 'PetV2' : undefined))

    const named = registry.register($t.Object({ id: $t.String() }, { $id: 'v2/Pet' }), 'output', 'GET /a response.200')
    const inlined = registry.register(
      $t.Object({ id: $t.String() }, { $id: 'v1/Pet' }),
      'output',
      'GET /b response.200',
    )

    expect(named).toEqual({ $ref: '#/components/schemas/PetV2' })
    expect(inlined).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] })
  })

  it('builds nothing when no schema was named', () => {
    expect(new ComponentRegistry().build()).toBe(undefined)
  })

  // A stable order keeps the served document identical across restarts, so a diff of two builds is meaningful.
  it('sorts components by name', () => {
    const registry = new ComponentRegistry()

    registry.register($t.Object({}, { $id: 'Zebra' }), 'output', 'GET /z response.200')
    registry.register($t.Object({}, { $id: 'Aardvark' }), 'output', 'GET /a response.200')

    expect(Object.keys(registry.build() ?? {})).toEqual(['Aardvark', 'Zebra'])
  })
})

describe('componentName', () => {
  it('takes the last segment of a URI $id', () => {
    expect(componentName({ $id: 'https://example.com/schemas/Pet' })).toBe('Pet')
    expect(componentName({ $id: 'https://example.com/schemas#Pet' })).toBe('Pet')
  })

  it('names nothing for a missing, empty or segment-less $id', () => {
    expect(componentName({})).toBe(undefined)
    expect(componentName({ $id: '' })).toBe(undefined)
    expect(componentName({ $id: 42 })).toBe(undefined)
    expect(componentName({ $id: '/#/' })).toBe(undefined)
  })
})
