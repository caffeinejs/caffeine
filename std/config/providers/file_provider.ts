import { readFile } from 'node:fs/promises'

import { ErrConfig } from '../errors.js'
import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../types.js'
import { flattenObject } from './_flatten.js'

/** Turns a config file's text into the object its keys are flattened from. */
export type ConfigFileParser = (text: string) => Record<string, unknown>

/**
 * Reads configuration from a file, in whatever format the parser it was given understands.
 *
 * The parser is a constructor argument rather than something looked up by file extension, because a registry
 * keyed by extension has to live somewhere shared: the previous design held a process-wide map that any
 * side-effect import could mutate, which made two applications in one process fight over `.json` and let one
 * test leak a format into the next. A source that carries its own parser is answerable for its own format.
 *
 * `std` therefore ships no parser beyond JSON ({@link JSONConfigProvider}). A YAML or TOML file is read by
 * handing this the parse function from whichever library the application already depends on:
 *
 * ```ts
 * new FileConfigProvider('./config/app.yaml', text => YAML.parse(text))
 * ```
 */
export class FileConfigProvider implements ConfigProvider {
  readonly id: string
  readonly #filePath: string
  readonly #parse: ConfigFileParser

  constructor(filePath: string, parse: ConfigFileParser) {
    this.#filePath = filePath
    this.#parse = parse
    this.id = `file:${filePath}`
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    const text = await readFile(this.#filePath, 'utf8')
    const parsed = this.#parsed(text)
    const entries = new Map<string, ConfigEntry>()

    flattenObject(parsed, this.id, '', entries)

    return [{ name: this.id, entries }]
  }

  /**
   * Parses the file and insists the result is a mapping.
   *
   * Both guards name the file, which the parser itself cannot: a bare `SyntaxError` from `JSON.parse` says
   * "Unexpected token" and nothing about which of the application's sources produced it.
   *
   * The shape check is not pedantry. `flattenObject` indexes an array into `0`, `1`, ... and turns a bare
   * scalar into a single empty-string key, so a file that is a list rather than a mapping would merge as a
   * plausible-looking set of nonsense keys instead of failing.
   */
  #parsed(text: string): Record<string, unknown> {
    let parsed: unknown

    try {
      parsed = this.#parse(text)
    } catch (error) {
      throw new ErrConfig(
        `Cannot parse config file "${this.#filePath}": ${error instanceof Error ? error.message : String(error)}`,
        'ERR_CONFIG_FILE_PARSE',
        error,
        'Check the file for a syntax error',
        'Make sure the parser passed to the provider matches the file format',
      )
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ErrConfig(
        `Cannot parse config file "${this.#filePath}": the parser returned ${describe(parsed)},` +
          ' but a config file must be a mapping at the top level',
        'ERR_CONFIG_FILE_PARSE',
        undefined,
        'Wrap the file contents in a top-level object',
        'Return an empty object from the parser when the file is empty',
      )
    }

    return parsed as Record<string, unknown>
  }
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`
}
