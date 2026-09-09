import { readFile } from 'node:fs/promises'
import { join, parse } from 'node:path'

import { ErrConfig } from '../errors.js'
import { flattenObject } from '../flatten.js'
import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../types.js'

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
 *
 * Each active profile also loads a sibling named `{stem}-{profile}{ext}` next to that path, when the file
 * exists. Later profiles override earlier ones, and every profile file overrides the constructor path. A
 * missing sibling is skipped; a missing constructor path still fails.
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

  async load(ctx: ResolutionContext): Promise<PropertySource[]> {
    const sources: PropertySource[] = []

    // Last unique profile first: mergeSources is first-wins, so this is the only order that makes a later
    // profile override an earlier one and every profile override the constructor path.
    for (const profile of uniqueProfiles(ctx.profiles).toReversed()) {
      assertProfileSegment(profile)

      const source = await this.#loadFile(this.#profilePath(profile), profile)
      if (source !== undefined) {
        sources.push(source)
      }
    }

    sources.push(await this.#loadFile(this.#filePath))
    return sources
  }

  #profilePath(profile: string): string {
    const { dir, name, ext } = parse(this.#filePath)
    return join(dir, `${name}-${profile}${ext}`)
  }

  /**
   * Reads one file into a property source. `profile` set means the file is optional: `ENOENT` yields nothing
   * rather than failing, and matching entries carry that profile. The constructor path is required.
   */
  async #loadFile(filePath: string): Promise<PropertySource>
  async #loadFile(filePath: string, profile: string): Promise<PropertySource | undefined>
  async #loadFile(filePath: string, profile?: string): Promise<PropertySource | undefined> {
    let text: string

    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (profile !== undefined && isENOENT(error)) {
        return undefined
      }
      throw error
    }

    const origin = `file:${filePath}`
    const entries = new Map<string, ConfigEntry>()

    flattenObject(this.#parsed(filePath, text), origin, '', entries)

    if (profile !== undefined) {
      for (const entry of entries.values()) {
        entry.profile = profile
      }
    }

    return { name: origin, entries }
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
  #parsed(filePath: string, text: string): Record<string, unknown> {
    let parsed: unknown

    try {
      parsed = this.#parse(text)
    } catch (error) {
      throw new ErrConfig(
        `Cannot parse config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
        'ERR_CONFIG_FILE_PARSE',
        error,
        'Check the file for a syntax error',
        'Make sure the parser passed to the provider matches the file format',
      )
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ErrConfig(
        `Cannot parse config file "${filePath}": the parser returned ${describe(parsed)},` +
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

function uniqueProfiles(profiles: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const profile of profiles) {
    if (profile === '' || seen.has(profile)) {
      continue
    }
    seen.add(profile)
    out.push(profile)
  }

  return out
}

/** A profile becomes a filename segment; anything that can walk out of the config directory is refused. */
function assertProfileSegment(profile: string): void {
  if (profile === '.' || profile === '..' || profile.includes('/') || profile.includes('\\')) {
    throw new ErrConfig(
      `Cannot load profile config for "${profile}": a profile name must be a single path segment`,
      'ERR_CONFIG_PROFILE',
      undefined,
      'Use a profile name without path separators or ".."',
    )
  }
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`
}
