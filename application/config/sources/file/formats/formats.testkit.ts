import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSON5 from 'json5'

import { mergeInterpolated } from '../../../interpolation.js'
import { passthroughConfigSchema } from '../../../schema.js'
import { testTokens } from '../../../tokens.testkit.js'
import type { ConfigDefinition, ConfigLoadContext, ConfigSchema, ConfigSource } from '../../../types.js'
import { JSONConfigSource } from '../../json/index.js'
import { YAMLConfigSource } from '../../yaml/index.js'
import { FileConfigSource, type FileConfigSourceOptions } from '../file.js'

// Each format keeps its files in `_testdata/<ext>/`, each named `<name>.<ext>`. The core set, the files
// `core.test.ts` reads, is in every format's folder under the same names and with the same meaning, so one
// expectation serves every format. A file only one format has belongs to that format's own suite.

/** A config file format: the source an application reads it with, and the extension its files carry. */
export interface Format {
  readonly name: string
  readonly ext: string
  readonly source: (path: string, options?: FileConfigSourceOptions) => FileConfigSource
}

export const json: Format = {
  name: 'JSON',
  ext: 'json',
  source: (path, options) => new JSONConfigSource(path, options),
}

export const yaml: Format = {
  name: 'YAML',
  ext: 'yaml',
  source: (path, options) => new YAMLConfigSource(path, options),
}

export const json5: Format = {
  name: 'JSON5',
  ext: 'json5',
  source: (path, options) => new FileConfigSource(path, text => JSON5.parse(text) as Record<string, unknown>, options),
}

export const FORMATS: readonly Format[] = [json, yaml, json5]

const testdata = fileURLToPath(new URL('./_testdata', import.meta.url))

/** The file `name` names in `format`: `_testdata/<ext>/<name>.<ext>`. */
export function fixture(format: Format, name: string): string {
  return join(testdata, format.ext, `${name}.${format.ext}`)
}

export function context(profiles: string[] = []): ConfigLoadContext {
  return { profiles, signal: new AbortController().signal, logger: undefined as never }
}

export function definition<T = Record<string, unknown>>(
  sources: ConfigSource[],
  schema: ConfigSchema<T> = passthroughConfigSchema as ConfigSchema<T>,
): ConfigDefinition<T> {
  return { schema, ...testTokens(), sources, loadTimeoutMs: 30_000 }
}

/** Reads a fixture as a file source does, under `profiles`, then interpolates it against `env` alone. */
export async function interpolateFixture(
  format: Format,
  name: string,
  env: Record<string, string>,
  profiles: string[] = [],
): Promise<Record<string, unknown>> {
  const layers = await format.source(fixture(format, name)).load(context(profiles))
  return mergeInterpolated(layers, env) as Record<string, unknown>
}

/**
 * Loads `text` as a file of `format`, written to a temp dir, and returns what the load threw along with the file's
 * path. For text that does not parse, which `_testdata` never holds.
 */
export async function loadText(format: Format, text: string): Promise<{ error: unknown; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'caffeine-config-'))
  try {
    const path = join(dir, `app.${format.ext}`)
    await writeFile(path, `${text}\n`, 'utf8')
    const error = await format
      .source(path)
      .load(context())
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
    return { error, path }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
