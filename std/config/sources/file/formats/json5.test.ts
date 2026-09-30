import { beforeAll, describe, expect, it } from 'vitest'

import { interpolateFixture, json5, loadText } from './formats.testkit.js'

describe('JSON5 syntax', () => {
  // JSON5 drops a backslash before any character, and decodes a Unicode escape, before interpolation sees the text:
  // `backslash` and `unicode` hold live placeholders. Only `$${` keeps one literal.
  const rows: [string, unknown][] = [
    ['apostrophe', "it's n"],
    ['quotes', 'say "n"'],
    ['continued', 'Hi n and bye'],
    ['backslash', 'n'],
    ['unicode', 'n'],
    // A number reaches text as JavaScript writes it, not as the file does.
    ['hex', 8080],
    ['fromHex', 'port 8080'],
    ['infinite', Infinity],
    ['fromInfinite', 'Infinity'],
  ]

  let out: Record<string, unknown>

  beforeAll(async () => {
    out = await interpolateFixture(json5, 'syntax', { NAME: 'n' })
  })

  // The rows are the whole file: a case added to it without a row here would be checked by nothing.
  it('reads every key of the fixture', () => {
    expect(Object.keys(out)).toEqual(rows.map(([key]) => key))
  })

  it.each(rows)('reads %s as %j', (key, expected) => {
    expect(out[key]).toEqual(expected)
  })
})

describe('JSON5 mistakes', () => {
  it.each([
    ['an unquoted placeholder', '{ port: ${env:PORT} }'],
    ['an unquoted placeholder in a list', '{ origins: [${env:ORIGIN}] }'],
  ])('fails to parse %s, naming the file', async (_label, text) => {
    const { error, path } = await loadText(json5, text)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(path)
  })
})
