import { describe, expect, it } from 'vitest'

import { ErrTemplateConfiguration, ErrTemplateLimit } from '../errors.js'
import { html as tag, unsafeHTML } from './html.js'
import type { HTMLValue, SafeHTML } from './html.js'
import { httpsURL } from './url.js'

describe('inline HTML', () => {
  it('escapes text without interpreting markup and omits false and nullish values', () => {
    const output = tag`<p>${['<&"\'', 12, true, false, null, undefined, ['end']]}</p>`
    expect(output.toString()).toBe('<p>&lt;&amp;"\'12trueend</p>')
  })

  it('escapes every allowed quoted attribute independently of adjacent text', () => {
    const value = '" onmouseover="evil&<>'
    expect(tag`<img title="before ${value} after" alt="${value}" aria-label="${value}" />${value}`.toString()).toBe(
      '<img title="before &quot; onmouseover=&quot;evil&amp;&lt;&gt; after" alt="&quot; onmouseover=&quot;evil&amp;&lt;&gt;" aria-label="&quot; onmouseover=&quot;evil&amp;&lt;&gt;">" onmouseover="evil&amp;&lt;&gt;',
    )
  })

  it('accepts single quoted attribute slots and escapes their contents for serialization', () => {
    expect(tag`<img alt='${'"quoted" & <value>'}'>`.toString()).toBe(
      '<img alt="&quot;quoted&quot; &amp; &lt;value&gt;">',
    )
  })

  it('normalizes whole HTTPS URL slots and escapes query separators', () => {
    const url = new URL('https://EXAMPLE.com/receipt?a=1&b=2')
    const validated = httpsURL(url)
    url.protocol = 'http:'
    expect(tag`<a href="${validated}">receipt</a><img src="${validated}" />`.toString()).toBe(
      '<a href="https://example.com/receipt?a=1&amp;b=2">receipt</a><img src="https://example.com/receipt?a=1&amp;b=2">',
    )
  })

  it.each(['http://example.com', '//example.com', '/path', 'javascript:alert(1)', 'https://user:pass@example.com'])(
    'rejects a URL outside the HTTPS contract: %s',
    value => {
      expect(() => httpsURL(value)).toThrow(TypeError)
    },
  )

  it('requires a real validated URL and keeps URLs out of scalar positions', () => {
    expect(() => tag`<a href="${'https://example.com'}">link</a>`).toThrow(TypeError)
    expect(
      () => tag`<a href="${{ toString: () => 'https://example.com' } as ReturnType<typeof httpsURL>}">link</a>`,
    ).toThrow(TypeError)
    expect(() => tag`${httpsURL('https://example.com')}`).toThrow(TypeError)
  })

  it.each([
    () => tag`<${'div'}>text</div>`,
    () => tag`<div ${'title'}="text"></div>`,
    () => tag`<div title=${'text'}></div>`,
    () => tag`<div onclick="${'text'}"></div>`,
    () => tag`<div style="${'text'}"></div>`,
    () => tag`<div data-label="${'text'}"></div>`,
    () => tag`<!-- ${'text'} -->`,
    () =>
      tag`<script>
        ${'text'}
      </script>`,
    () =>
      tag`<style>
        ${'text'}
      </style>`,
    () => tag`<textarea>${'text'}</textarea>`,
    () => tag`<title>${'text'}</title>`,
    () => tag`<template>${'text'}</template>`,
    () => tag`<svg><text>${'text'}</text></svg>`,
    () =>
      tag`<svg>
        <foreignObject><p>${'text'}</p></foreignObject>
      </svg>`,
    () => tag`<a href="prefix${httpsURL('https://example.com')}">link</a>`,
    () => tag`<img src="${httpsURL('https://example.com')}${httpsURL('https://example.com')}" />`,
  ])('rejects slots in unsupported syntactic contexts', render => {
    expect(render).toThrow(ErrTemplateConfiguration)
  })

  it('rejects malformed static fragments and duplicate attributes', () => {
    expect(() => tag`<div title="${'value'}" title="other"></div>`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<div title="${'value'}></div>`).toThrow(ErrTemplateConfiguration)
  })

  it('requires balanced authored elements and rejects parser relocation', () => {
    expect(() => tag`<b>${'value'}`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`</div>${'value'}`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<p><div>${'value'}</p></div>`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<table>outside${'value'}</table>`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<div>before</unknown>after${'value'}</div>`).toThrow(ErrTemplateConfiguration)
    expect(tag`<table><tr><td>${'value'}</td></tr></table>`.toString()).toBe(
      '<table><tbody><tr><td>value</td></tr></tbody></table>',
    )
  })

  it('parses trusted fragments in their parent and preserves neighboring scalar isolation', () => {
    const fragment = unsafeHTML('</div><script>trusted()</script><b>open')
    expect(tag`<div>${fragment}${'<img src=x onerror=evil()>'}</div>`.toString()).toBe(
      '<div><script>trusted()</script><b>open</b>&lt;img src=x onerror=evil()&gt;</div>',
    )
    expect(tag`<table><tbody>${unsafeHTML('<tr><td>cell</td></tr>')}</tbody></table>`.toString()).toBe(
      '<table><tbody><tr><td>cell</td></tr></tbody></table>',
    )
    expect(() => tag`<table>${unsafeHTML('<div>caption</div>')}</table>`).toThrow(ErrTemplateConfiguration)
    expect(tag`<div>${unsafeHTML('<textarea>')}${'<b>value</b>'}</div>`.toString()).toBe(
      '<div><textarea></textarea>&lt;b&gt;value&lt;/b&gt;</div>',
    )
  })

  it.each([
    { name: 'table', render: (value: HTMLValue) => tag`<table>${value}</table>` },
    { name: 'tbody', render: (value: HTMLValue) => tag`<table><tbody>${value}</tbody></table>` },
    { name: 'thead', render: (value: HTMLValue) => tag`<table><thead>${value}</thead></table>` },
    { name: 'tfoot', render: (value: HTMLValue) => tag`<table><tfoot>${value}</tfoot></table>` },
    { name: 'tr', render: (value: HTMLValue) => tag`<table><tbody><tr>${value}</tr></tbody></table>` },
    { name: 'colgroup', render: (value: HTMLValue) => tag`<table><colgroup>${value}</colgroup></table>` },
  ])('rejects non-HTML-whitespace scalar text in a $name slot', ({ render }) => {
    for (const value of ['outside', 0, true, '\u00a0', [' \n', 'outside']]) {
      expect(() => render(value)).toThrow(ErrTemplateConfiguration)
    }
  })

  it('rejects branded fragment text that would move outside its table context', () => {
    expect(() => tag`<table>${unsafeHTML('outside<tr><td>cell</td></tr>')}</table>`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<table><tbody>${unsafeHTML('outside')}</tbody></table>`).toThrow(ErrTemplateConfiguration)
    expect(() => tag`<table><tbody><tr>${unsafeHTML('outside')}</tr></tbody></table>`).toThrow(ErrTemplateConfiguration)
  })

  it('keeps HTML whitespace and valid branded rows in table slots', () => {
    expect(
      tag`<table>${[' \t\n\f\r', null, false, undefined, unsafeHTML('<tr><td>cell</td></tr>')]}</table>`.toString(),
    ).toBe('<table> \t\n\f\r<tbody><tr><td>cell</td></tr></tbody></table>')
    expect(tag`<table><colgroup>${' \t\n\f\r'}</colgroup></table>`.toString()).toBe(
      '<table><colgroup> \t\n\f\r</colgroup></table>',
    )
  })

  it('composes branded fragments without sharing state between calls of a cached tag', () => {
    const render = (value: HTMLValue) => tag`<p>${value}</p>`
    expect(render(tag`<b>${'one'}</b>`).toString()).toBe('<p><b>one</b></p>')
    expect(render('two').toString()).toBe('<p>two</p>')
    expect(render(unsafeHTML('<i>three</i>')).toString()).toBe('<p><i>three</i></p>')
  })

  it('refuses forged HTML brands and raw fragments in attributes', () => {
    const forged = { toString: () => '<script>untrusted()</script>' } as SafeHTML
    expect(() => tag`${forged}`).toThrow(TypeError)
    expect(() => tag`<p title="${unsafeHTML('<b>trusted</b>')}"></p>`).toThrow(TypeError)
    expect(() => unsafeHTML(12 as unknown as string)).toThrow(TypeError)
  })

  it('counts encoded bytes in literals and refuses outputs larger than the body bound', () => {
    const strings = Object.freeze(Object.assign(['é'.repeat(32_769)], { raw: Object.freeze(['']) }))
    expect(() => tag(strings)).toThrow(ErrTemplateLimit)
    expect(unsafeHTML('x'.repeat(524_288)).toString().length).toBe(524_288)
    expect(() => unsafeHTML('é'.repeat(262_145))).toThrow(ErrTemplateLimit)
    expect(() => tag`${'&'.repeat(104_858)}`).toThrow(ErrTemplateLimit)
    expect(() => tag`${['x'.repeat(300_000), 'x'.repeat(300_000)]}`).toThrow(ErrTemplateLimit)
  })

  it('bounds array nesting and detects cycles while permitting repeated independent arrays', () => {
    const cycle: HTMLValue[] = []
    cycle.push(cycle)
    expect(() => tag`${cycle}`).toThrow(ErrTemplateLimit)
    let nested: HTMLValue = 'value'
    for (let index = 0; index < 32; index++) {
      nested = [nested]
    }
    expect(tag`${nested}`.toString()).toBe('value')
    expect(() => tag`${[nested]}`).toThrow(ErrTemplateLimit)
    const shared = ['same']
    expect(tag`${[shared, shared]}`.toString()).toBe('samesame')
  })

  it('refuses deeply nested trusted fragments before serialization', () => {
    const nested = '<div>'.repeat(130) + 'text' + '</div>'.repeat(130)
    expect(() => tag`${unsafeHTML(nested)}`).toThrow(ErrTemplateLimit)
  })

  it('does not process marker-like content introduced by a trusted fragment', () => {
    expect(tag`${unsafeHTML('<b><!--caffeine-slot-0x-1-z--></b>')}${'tail'}`.toString()).toBe(
      '<b><!--caffeine-slot-0x-1-z--></b>tail',
    )
    expect(tag`caffeine-slot-0x-0-z${'value'}`.toString()).toBe('caffeine-slot-0x-0-zvalue')
  })

  it('rejects mutable direct-call tag input', () => {
    const strings = Object.assign([''], { raw: [''] })
    expect(() => tag(strings)).toThrow(TypeError)
  })
})
