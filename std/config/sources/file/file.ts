import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { ErrConfig, messageOf } from '../../errors.js'
import { checkInterpolation } from '../../interpolation.js'
import type { ConfigLayer, ConfigLoadContext, ConfigObject, ConfigSource } from '../../types.js'

/** Turns a config file's text into the object it describes. May be synchronous or asynchronous. */
export type ConfigFileParser = (text: string) => Record<string, unknown> | Promise<Record<string, unknown>>

const kDocuments = Symbol('config file documents')

/**
 * What a parser returns for a file that holds several documents, in the order they apply. Each is a layer of its
 * own, so a later one wins over an earlier one, and an empty one, `null`, adds nothing.
 */
export function configDocuments(documents: readonly unknown[]): Record<string, unknown> {
  return { [kDocuments]: documents }
}

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
  /**
   * Whether `${env:NAME}` and `${config:path}` in the file's strings are filled in. **Defaults to `true`.** Every
   * `${` must then open a well-formed placeholder, or be written `$${`, or the load fails.
   *
   * A placeholder can read any environment variable. Turn this off for a file written by someone who should not
   * read the environment, or for one that must be read as written.
   */
  interpolate?: boolean
}

/**
 * Configuration from a file, in whatever format the parser understands, with profile siblings layered over it.
 *
 * Given `./config/app.json` and active profiles `eu` then `canary`, it reads `app.json`, then `app-eu.json`, then
 * `app-canary.json`. A sibling overrides the base, a later profile overrides an earlier one, and a sibling that is
 * not there is skipped.
 *
 * The tree is taken literally, so a key holding a dot is one key. A flat format expands its keys in the parser:
 * `new FileConfigSource('./app.ini', text => expandKeys(ini.parse(text)))`.
 *
 * Its strings are interpolated unless `interpolate` is `false`: `"${env:NAME:-No Name} and ${config:team.nickname}"`
 * reads an environment variable, with a default, and a value of the merged configuration, from any source.
 */
export class FileConfigSource implements ConfigSource {
  readonly name: string
  readonly watch?: (changed: () => void) => () => void
  readonly #path: string
  readonly #parse: ConfigFileParser
  readonly #missingIsFine: boolean
  readonly #interpolate: boolean

  constructor(path: string, parse: ConfigFileParser, options: FileConfigSourceOptions = {}) {
    this.name = options.name ?? `file:${path}`
    this.#path = path
    this.#parse = parse
    this.#missingIsFine = options.optional ?? true
    this.#interpolate = options.interpolate ?? true

    if (options.watch === true) {
      this.watch = changed => watchFiles(path, changed)
    }
  }

  /**
   * @throws ErrConfig `ERR_CONFIG_FILE_PARSE` when a file does not parse to an object, naming the file.
   * @throws ErrConfig `ERR_CONFIG_INTERPOLATION` when a placeholder is malformed, naming the file and the path.
   */
  async load(context: ConfigLoadContext): Promise<readonly ConfigLayer[]> {
    const layers: ConfigLayer[] = []
    const interpolate = this.#interpolate

    for (const { name, data } of await this.#read(this.#path, this.#missingIsFine)) {
      layers.push({ name, data, interpolate })
    }

    // No sibling depends on another, so they are read together and layered in profile order.
    const siblings = await Promise.all(
      context.profiles.map(async profile => ({
        profile,
        read: await this.#read(profilePath(this.#path, profile), true),
      })),
    )

    for (const { profile, read } of siblings) {
      for (const { name, data } of read) {
        layers.push({ name, data, profile, interpolate })
      }
    }

    return layers
  }

  /** What the file at `path` holds: nothing when it is missing and may be, otherwise a layer per document. */
  async #read(path: string, missingIsFine: boolean): Promise<Pick<ConfigLayer, 'name' | 'data'>[]> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (missingIsFine && (error as { code?: string }).code === 'ENOENT') {
        return []
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

    if (isDocuments(parsed)) {
      return this.#documents(path, parsed[kDocuments])
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

    if (this.#interpolate) {
      checkInterpolation(parsed as Record<string, unknown>, path)
    }

    return [{ name: `file:${path}`, data: parsed as ConfigObject }]
  }

  /**
   * A layer per document that holds anything. With more than one, each is named after its place in the file,
   * `file:<path>#2` for the second, so a value and a failure both point at the document they came from.
   */
  #documents(path: string, documents: readonly unknown[]): Pick<ConfigLayer, 'name' | 'data'>[] {
    const found: [n: number, data: Record<string, unknown>][] = []

    for (const [i, document] of documents.entries()) {
      // An empty document adds nothing.
      if (document === null) {
        continue
      }
      if (typeof document !== 'object' || Array.isArray(document)) {
        throw new ErrConfig(
          `Cannot parse config file "${path}": document ${i + 1} is ${describe(document)}, but every document must be a mapping at the top level`,
          'ERR_CONFIG_FILE_PARSE',
          undefined,
          'Make every document in the file a mapping, or remove it',
        )
      }
      found.push([i + 1, document as Record<string, unknown>])
    }

    return found.map(([n, data]) => {
      const file = found.length > 1 ? `${path}#${n}` : path
      if (this.#interpolate) {
        checkInterpolation(data, file)
      }
      return { name: `file:${file}`, data: data as ConfigObject }
    })
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

function isDocuments(value: unknown): value is { [kDocuments]: readonly unknown[] } {
  return typeof value === 'object' && value !== null && kDocuments in value
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`
}
