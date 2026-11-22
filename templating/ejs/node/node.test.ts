import { describe, expect, it } from 'vitest'

import type { TemplateContext } from '../../compiled.js'
import { ejsTemplates } from './node.js'

const signal = new AbortController().signal
const emptyContext: TemplateContext = {
  signal,
  partials: [],
  partial() {
    throw new Error('Unexpected partial')
  },
}

describe('EJS templates', () => {
  it('escapes named HTML locals and preserves authored text', async () => {
    const engine = ejsTemplates()
    const html = await engine.compile({ name: 'page', kind: 'html', source: '<%= locals.title %>', signal })
    const text = await engine.compile({ name: 'page', kind: 'text', source: '<%= locals.title %>', signal })
    expect(html({ title: '<"one">&' }, emptyContext)).toBe('&lt;&#34;one&#34;&gt;&amp;')
    expect(text({ title: '<"one">&' }, emptyContext)).toBe('<"one">&')
  })

  it('requires named locals in strict mode', async () => {
    const program = await ejsTemplates().compile({ name: 'page', kind: 'html', source: '<%= title %>', signal })
    expect(() => program({ title: 'name' }, emptyContext)).toThrow(ReferenceError)
  })

  it('resolves nested includes with merged locals and keeps empty includes empty', async () => {
    const engine = ejsTemplates()
    const page = await engine.compile({
      name: 'page',
      kind: 'html',
      source: '<%- include("middle", { title: "<nested>" }) %><%- include("empty") %>',
      signal,
    })
    const middle = await engine.compile({ name: 'middle', kind: 'html', source: '<%- include("tail") %>', signal })
    const tail = await engine.compile({
      name: 'tail',
      kind: 'html',
      source: '<%= locals.title %>/<%= locals.other %>',
      signal,
    })
    const empty = await engine.compile({ name: 'empty', kind: 'html', source: '', signal })
    const programs = { middle, tail, empty }
    const context: TemplateContext = {
      signal,
      partials: Object.keys(programs),
      partial(alias, model = {}) {
        return String(programs[alias as keyof typeof programs](model, context))
      },
    }
    expect(page({ title: 'original', other: 'kept' }, context)).toBe('&lt;nested&gt;/kept')
  })

  it('rejects missing aliases without invoking an ambient file loader', async () => {
    const program = await ejsTemplates().compile({
      name: 'page',
      kind: 'html',
      source: '<%- include("missing") %>',
      signal,
    })
    const failure = new Error('Caller rejected the missing alias')
    const aliases: string[] = []
    const context: TemplateContext = {
      ...emptyContext,
      partial(alias) {
        aliases.push(alias)
        throw failure
      },
    }
    expect(() => program({}, context)).toThrow(failure)
    expect(aliases).toEqual(['missing'])
  })

  it('copies only own locals and refuses unsafe include locals', async () => {
    const inherited = await ejsTemplates().compile({
      name: 'page',
      kind: 'html',
      source: '<%= locals.inherited %>',
      signal,
    })
    expect(inherited(Object.create({ inherited: 'secret' }), emptyContext)).toBe('')
    const program = await ejsTemplates().compile({
      name: 'page',
      kind: 'html',
      source: '<%- include("part", { constructor: "unsafe" }) %>',
      signal,
    })
    expect(() => program({}, { ...emptyContext, partials: ['part'] })).toThrow('unsafe property')
  })
})
