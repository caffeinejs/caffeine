import { describe, expect, it } from 'vitest'

import type { TemplateContext } from '../../compiled.js'
import { handlebarsTemplates } from './node.js'

const signal = new AbortController().signal
const emptyContext: TemplateContext = {
  signal,
  partials: [],
  partial() {
    throw new Error('Unexpected partial')
  },
}

describe('Handlebars templates', () => {
  it('escapes HTML and leaves text variants literal', async () => {
    const engine = handlebarsTemplates()
    const html = await engine.compile({ name: 'page', kind: 'html', source: '{{title}}', signal })
    const text = await engine.compile({ name: 'page', kind: 'text', source: '{{title}}', signal })
    expect(html({ title: '<a "one">&' }, emptyContext)).toBe('&lt;a &quot;one&quot;&gt;&amp;')
    expect(text({ title: '<a "one">&' }, emptyContext)).toBe('<a "one">&')
  })

  it('supports scoped nested and empty partial functions', async () => {
    const engine = handlebarsTemplates()
    const page = await engine.compile({ name: 'page', kind: 'html', source: '{{> middle}}{{> empty}}', signal })
    const middle = await engine.compile({
      name: 'middle',
      kind: 'html',
      source: '{{#if title}}{{> tail}}{{/if}}',
      signal,
    })
    const tail = await engine.compile({ name: 'tail', kind: 'html', source: '{{title}}', signal })
    const empty = await engine.compile({ name: 'empty', kind: 'html', source: '', signal })
    const programs = { middle, tail, empty }
    const context: TemplateContext = {
      signal,
      partials: Object.keys(programs),
      partial(alias, model = {}) {
        return String(programs[alias as keyof typeof programs](model, context))
      },
    }
    expect(page({ title: '<nested>' }, context)).toBe('&lt;nested&gt;')
    expect(() => page({ title: 'x' }, emptyContext)).toThrow()
  })

  it('keeps ordinary prototype properties inaccessible', async () => {
    const program = await handlebarsTemplates().compile({
      name: 'page',
      kind: 'html',
      source: '{{inherited}}/{{own}}',
      signal,
    })
    const model = Object.assign(Object.create({ inherited: 'secret' }), { own: 'visible' })
    expect(program(model, emptyContext)).toBe('/visible')
  })

  it('validates HTTPS URLs before escaping quoted attributes', async () => {
    const program = await handlebarsTemplates().compile({
      name: 'link',
      kind: 'html',
      source: '<a href="{{httpsURL url}}">link</a>',
      signal,
    })
    expect(program({ url: 'https://example.test/?a=1&b=2' }, emptyContext)).toBe(
      '<a href="https://example.test/?a&#x3D;1&amp;b&#x3D;2">link</a>',
    )
    expect(() => program({ url: 'javascript:alert(1)' }, emptyContext)).toThrow()
  })
})
