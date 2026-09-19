import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { ErrConfig, messageOf } from '../errors.js'
import { activeProfiles, PROFILES_KEY } from '../profiles.js'
import { readPath } from '../tree.js'
import type { ConfigLayer, ConfigLoadContext, ConfigObject, ConfigSource } from '../types.js'

/** Turns a config file's text into the object it describes. May be synchronous or asynchronous. */
export type ConfigFileParser = (text: string) => Record<string, unknown> | Promise<Record<string, unknown>>

export interface FileConfigSourceOptions {
  /**
   * Whether a missing base file is acceptable. **Defaults to `true`**: an absent file contributes nothing. A file
   * that is there and cannot be read or parsed always fails, whatever this says.
   *
   * A profile file is always optional: running under a profile that has no overrides is the normal case.
   */
  optional?: boolean
  /** Reload whenever the file or one of its profile siblings changes. */
  watch?: boolean
  /** Defaults to `file:<path>`. */
  name?: string
}

/**
 * Configuration from a file, in whatever format the parser understands, with profile siblings layered over it.
 *
 * Given `./config/app.json` and active profiles `eu` then `canary`, it reads `app.json`, then `app-eu.json`, then
 * `app-canary.json`. A sibling overrides the base, a later profile overrides an earlier one, and a sibling that is
 * not there is skipped.
 *
 * When nothing named a profile up front, the base file decides, from the `caffeine.profiles` it declares. Only
 * the base: a sibling naming the siblings would need a second pass over every source.
 *
 * The tree is taken literally, so a key holding a dot is one key. A flat format expands its keys in the parser:
 * `new FileConfigSource('./app.ini', text => expandKeys(ini.parse(text)))`.
 */
export class FileConfigSource implements ConfigSource {
  readonly name: string
  readonly watch?: (changed: () => void) => () => void
  readonly #path: string
  readonly #parse: ConfigFileParser
  readonly #missingIsFine: boolean

  constructor(path: string, parse: ConfigFileParser, options: FileConfigSourceOptions = {}) {
    this.name = options.name ?? `file:${path}`
    this.#path = path
    this.#parse = parse
    this.#missingIsFine = options.optional ?? true

    if (options.watch === true) {
      this.watch = changed => watchFiles(path, changed)
    }
  }

  /**
   * @throws ErrConfig `ERR_CONFIG_FILE_PARSE` when a file does not parse to an object, naming the file.
   */
  async load(context: ConfigLoadContext): Promise<readonly ConfigLayer[]> {
    const base = await this.#read(this.#path, this.#missingIsFine)

    const profiles = context.profiles.length > 0 ? context.profiles : activeProfiles(readPath(base, PROFILES_KEY))
    const layers: ConfigLayer[] = []

    if (base !== undefined) {
      layers.push({ name: `file:${this.#path}`, data: base as ConfigObject })
    }

    for (const profile of profiles) {
      const path = profilePath(this.#path, profile)
      const parsed = await this.#read(path, true)
      if (parsed !== undefined) {
        layers.push({ name: `file:${path}`, data: parsed as ConfigObject, profile })
      }
    }

    return layers
  }

  async #read(path: string, missingIsFine: boolean): Promise<Record<string, unknown> | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (missingIsFine && (error as { code?: string }).code === 'ENOENT') {
        return undefined
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = await this.#parse(text)
    } catch (error) {
      throw new ErrConfig(
        `Cannot parse config file "${path}": ${messageOf(error)}`,
        'ERR_CONFIG_FILE_PARSE',
        error,
        'Check the file for a syntax error',
        'Make sure the parser handed to the source matches the file format',
      )
    }

    // An array or a scalar would otherwise merge as a plausible-looking set of nonsense keys.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ErrConfig(
        `Cannot parse config file "${path}": the parser returned ${describe(parsed)}, but a config file must be a mapping at the top level`,
        'ERR_CONFIG_FILE_PARSE',
        undefined,
        'Wrap the file contents in a top-level object',
        'Return an empty object from the parser when the file is empty',
      )
    }

    return parsed as Record<string, unknown>
  }
}

/** `dir/name.ext` becomes `dir/name-<profile>.ext`. A path with no extension gets `-<profile>` appended. */
function profilePath(path: string, profile: string): string {
  const ext = extname(path)
  return join(dirname(path), `${basename(path, ext)}-${profile}${ext}`)
}

/**
 * Watches the directory rather than the file: editors, and mounted volumes such as a Kubernetes config map
 * (`..data`), replace a file instead of writing into it, and a watch on the old file would go quiet.
 */
function watchFiles(path: string, changed: () => void): () => void {
  const watcher = watch(dirname(path), (_event, filename) => {
    if (concernsFile(path, filename)) {
      changed()
    }
  })
  // A watcher that breaks makes a reload try the file, so a real problem surfaces as a failed load.
  watcher.on('error', () => changed())
  watcher.unref()

  return () => watcher.close()
}

/**
 * Whether a change the directory watcher reported can affect `path`: the file itself, a profile sibling, the
 * `..data` link a mounted volume swaps, or a change the platform could not name.
 */
export function concernsFile(path: string, filename: string | null): boolean {
  if (filename === null) {
    return true
  }

  const ext = extname(path)
  const stem = basename(path, ext)

  return (
    filename === basename(path) || filename === '..data' || (filename.startsWith(`${stem}-`) && filename.endsWith(ext))
  )
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`
}
