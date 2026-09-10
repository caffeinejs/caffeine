import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../config.js'
import { ErrConfig } from '../errors.js'
import { flattenObject } from '../flatten.js'

/** Turns a config file's text into the object its keys are flattened from. May be synchronous or asynchronous. */
export type ConfigFileParser = (text: string) => Record<string, unknown> | Promise<Record<string, unknown>>

export interface FileConfigProviderOptions {
  /**
   * Whether a missing base file is acceptable. **Defaults to `true`** — an absent file contributes nothing,
   * the way a Spring `application.yml` that is not on the path simply does not apply. Set `false` to make the
   * base file a hard requirement.
   *
   * A profile file (`app-<profile>.json`) is always optional regardless: an application that runs under a
   * profile it has no overrides for is the normal case, not an error.
   */
  optional?: boolean
}

/**
 * Reads configuration from a file, in whatever format the parser it was given understands, and layers
 * Spring-style profile files on top of it.
 *
 * Given `./config/app.json` and active profiles `['eu', 'canary']`, the provider reads `./config/app.json`,
 * then `./config/app-eu.json`, then `./config/app-canary.json`. A profile file overrides the base, and a
 * later active profile overrides an earlier one. Any file that is not there is skipped.
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
  readonly #optional: boolean

  constructor(filePath: string, parse: ConfigFileParser, options: FileConfigProviderOptions = {}) {
    this.#filePath = filePath
    this.#parse = parse
    this.#optional = options.optional ?? true
    this.id = `file:${filePath}`
  }

  async load(ctx: ResolutionContext): Promise<PropertySource[]> {
    const sources: PropertySource[] = []

    // Higher-priority sibling first: the engine merge is first-wins, so a later active profile must be read
    // before an earlier one, and every profile file before the base.
    for (let i = ctx.profiles.length - 1; i >= 0; i--) {
      const profile = ctx.profiles[i]
      const source = await this.#read(this.#profilePath(profile), profile, true)
      if (source !== undefined) {
        sources.push(source)
      }
    }

    const base = await this.#read(this.#filePath, undefined, this.#optional)
    if (base !== undefined) {
      sources.push(base)
    }

    return sources
  }

  /** The sibling path for a profile: `dir/name.ext` → `dir/name-<profile>.ext`; a path with no extension gets `-<profile>` appended. */
  #profilePath(profile: string): string {
    const ext = extname(this.#filePath)
    const stem = basename(this.#filePath, ext)
    return join(dirname(this.#filePath), `${stem}-${profile}${ext}`)
  }

  /** Reads and parses one file, or returns `undefined` when it is absent and that is allowed. */
  async #read(path: string, profile: string | undefined, optional: boolean): Promise<PropertySource | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (optional && (error as { code?: string }).code === 'ENOENT') {
        return undefined
      }
      throw error
    }

    const parsed = await this.#parsed(path, text)
    const name = `file:${path}`
    const entries = new Map<string, ConfigEntry>()

    flattenObject(parsed, name, '', entries)

    if (profile !== undefined) {
      for (const entry of entries.values()) {
        entry.profile = profile
      }
    }

    return { name, entries }
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
  async #parsed(path: string, text: string): Promise<Record<string, unknown>> {
    let parsed: unknown

    try {
      parsed = await this.#parse(text)
    } catch (error) {
      throw new ErrConfig(
        `Cannot parse config file "${path}": ${error instanceof Error ? error.message : String(error)}`,
        'ERR_CONFIG_FILE_PARSE',
        error,
        'Check the file for a syntax error',
        'Make sure the parser passed to the provider matches the file format',
      )
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ErrConfig(
        `Cannot parse config file "${path}": the parser returned ${describe(parsed)},` +
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
