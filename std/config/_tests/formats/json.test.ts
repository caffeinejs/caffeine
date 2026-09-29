import { beforeAll, describe, expect, it } from 'vitest'

import { interpolateFixture, json, loadText } from './formats.testkit.js'

describe('JSON syntax', () => {
  // JSON decodes its escapes before interpolation sees the text, and a backslash never escapes a placeholder:
  // `unicode` and `windowsPath` hold live ones. Only `$${` keeps a placeholder literal.
  const rows: [string, unknown][] = [
    ['escapeSequence', 'n\nn'],
    ['quotes', 'say "n"'],
    ['unicode', 'n'],
    ['windowsPath', 'C:\\data\\n'],
  ]

  let out: Record<string, unknown>

  beforeAll(async () => {
    out = await interpolateFixture(json, 'syntax', { NAME: 'n' })
  })

  // The rows are the whole file: a case added to it without a row here would be checked by nothing.
  it('reads every key of the fixture', () => {
    expect(Object.keys(out)).toEqual(rows.map(([key]) => key))
  })

  it.each(rows)('reads %s as %j', (key, expected) => {
    expect(out[key]).toEqual(expected)
  })
})

describe('JSON mistakes', () => {
  it.each([
    ['an unquoted placeholder', '{ "port": ${env:PORT} }'],
    // JSON5 reads the same text as a live placeholder: it drops the backslash instead.
    ['a backslash before a placeholder', '{ "a": "\\${env:NAME}" }'],
  ])('fails to parse %s, naming the file', async (_label, text) => {
    const { error, path } = await loadText(json, text)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(path)
  })
})
