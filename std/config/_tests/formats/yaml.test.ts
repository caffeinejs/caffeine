import { beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYAML } from 'yaml'

import { FileConfigSource } from '../../sources/file_source.js'
import { context, fixture, interpolateFixture, loadText, yaml, type Format } from './formats.testkit.js'

// YAML 1.2 has no merge key: `<<` is a key like any other unless the parser is told otherwise.
const yamlWithMergeKeys: Format = {
  ...yaml,
  parse: text => parseYAML(text, { merge: true }) as Record<string, unknown>,
}

describe('YAML syntax', () => {
  const rows: [string, unknown][] = [
    ['quotedDefault', 'a: b # c'],
    ['apostrophe', "it's n"],
    ['escapeSequence', 'n\nn'],
    ['escapedQuoted', '${env:NAME}'],
    ['literal', 'Hi n\nBye\n'],
    ['literalStrip', 'Hi n\nBye'],
    ['folded', 'Hi n and bye\n'],
    ['tagged', 'n'],
    ['flow', ['n', 'x-n']],
    ['commented', 'n'],
    ['tilde', null],
    ['empty', null],
    ['fromTilde', 'd'],
    ['fromEmpty', 'd'],
  ]

  let out: Record<string, unknown>

  beforeAll(async () => {
    out = await interpolateFixture(yaml, 'syntax', { NAME: 'n' })
  })

  // The rows are the whole file: a style added to it without a row here would be checked by nothing.
  it('reads every key of the fixture', () => {
    expect(Object.keys(out)).toEqual(rows.map(([key]) => key))
  })

  it.each(rows)('reads %s as %j', (key, expected) => {
    expect(out[key]).toEqual(expected)
  })
})

describe('YAML anchors and merge keys', () => {
  it('interpolates an alias at every path it is copied to', async () => {
    const out = await interpolateFixture(yamlWithMergeKeys, 'anchors', {})

    expect(out.primary).toEqual({ host: 'localhost', port: 5432, url: 'postgres://localhost:5432/app' })
    expect(out.replica).toEqual(out.primary)
  })

  // A merge key copies a placeholder's text, and a config path is absolute: the copy still reads the path it names,
  // whatever the map it landed in overrides.
  it('keeps a merged reference pointing at the path it names', async () => {
    const out = await interpolateFixture(yamlWithMergeKeys, 'anchors', {})

    expect(out.reporting).toEqual({ host: 'reporting.internal', port: 5432, url: 'postgres://localhost:5432/app' })
  })

  it('carries the environment into every copy', async () => {
    const out = await interpolateFixture(yamlWithMergeKeys, 'anchors', { DB_HOST: 'db.internal' })

    expect(out).toEqual({
      primary: { host: 'db.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
      replica: { host: 'db.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
      reporting: { host: 'reporting.internal', port: 5432, url: 'postgres://db.internal:5432/app' },
    })
  })
})

describe('YAML mistakes', () => {
  // Unquoted, ` #` opens a YAML comment and cuts the placeholder short. What would have been a wrong value is an error
  // that names the file.
  it('refuses a placeholder a YAML comment cut short', async () => {
    const path = fixture(yaml, 'mistakes/comment-in-default')

    await expect(new FileConfigSource(path, yaml.parse).load(context())).rejects.toThrow(
      `Cannot interpolate "greeting" in config file "${path}": the placeholder at character 1 is not closed`,
    )
  })

  it('counts the character across the lines of a block', async () => {
    const path = fixture(yaml, 'mistakes/malformed-in-block')

    await expect(new FileConfigSource(path, yaml.parse).load(context())).rejects.toThrow(
      `Cannot interpolate "script" in config file "${path}": the placeholder at character 17 has a prefix other than "env" or "config"`,
    )
  })

  // A formatter either refuses these or rewrites them into valid YAML that means something else, so they cannot be
  // kept as files: each is written out as the test runs.
  it.each([
    ['a ": " in an unquoted default', 'title: ${env:TITLE:-Caffeine: the framework}'],
    ['an unquoted placeholder in a flow sequence', 'origins: [${env:ORIGIN}]'],
    ['an unquoted placeholder in a flow mapping', 'db: { host: ${env:DB_HOST} }'],
    ['a backslash before a placeholder in double quotes', 'literal: "\\${env:NAME}"'],
  ])('fails to parse %s, naming the file', async (_label, text) => {
    const { error, path } = await loadText(yaml, text)

    expect(error).toMatchObject({ code: 'ERR_CONFIG_FILE_PARSE' })
    expect((error as Error).message).toContain(path)
  })
})
