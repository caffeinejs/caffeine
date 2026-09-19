import { buildTree, splitKey } from '../merge.js'
import type { ConfigLayer, ConfigSource } from '../types.js'

export interface ArgsConfigSourceOptions {
  /**
   * The arguments to read. Omitted, the host's own are used: `process.argv` where there is a `process`, nothing
   * where there is not.
   *
   * Registering this source is the opt-in, so nothing reads a command line unless the application asked. An
   * application that reads its arguments and is then booted inside a test runner reads the runner's switches, so
   * pass an explicit array wherever that matters.
   */
  argv?: readonly string[]
  /** Short-switch expansions, e.g. `{ '-p': 'server.port' }`. */
  switchMappings?: Record<string, string>
  /** Defaults to `args`. */
  name?: string
}

/**
 * Configuration from command-line arguments.
 *
 * | Argument               | Result                                |
 * | ---------------------- | ------------------------------------- |
 * | `--server.port=8080`   | `server.port` is `'8080'`             |
 * | `--server.port 8080`   | `server.port` is `'8080'`             |
 * | `--worker.offset -1`   | `worker.offset` is `'-1'`             |
 * | `--server:port=8080`   | `server.port` is `'8080'`             |
 * | `--server.verbose`     | `server.verbose` is `'true'`          |
 * | `--no-server.verbose`  | `server.verbose` is `'false'`         |
 * | `-p 8080` (mapped)     | `server.port` is `'8080'`             |
 * | `--`                   | stops reading; the rest is the app's  |
 *
 * Values stay text, exactly as from the environment, and the schema converts them. Everything before the first
 * `-`-prefixed token is skipped, so `process.argv`, `process.argv.slice(2)` and `Deno.args` all work as they are.
 * A later argument wins over an earlier one for the same key.
 */
export class ArgsConfigSource implements ConfigSource {
  readonly name: string
  readonly #argv: readonly string[] | undefined
  readonly #switchMappings: Record<string, string>

  constructor(options: ArgsConfigSourceOptions = {}) {
    this.name = options.name ?? 'args'
    this.#argv = options.argv
    this.#switchMappings = options.switchMappings ?? {}
  }

  /** @throws ErrConfig `ERR_CONFIG_KEY_CONFLICT` when one argument sets a path another uses as a parent. */
  load(): readonly ConfigLayer[] {
    const entries: [string[], string][] = []
    const origins = new Map<string, string>()

    for (const [path, value, origin] of parseArgv(this.#argv ?? hostArgv(), this.#switchMappings)) {
      const parts = splitKey(path)
      if (parts.includes('')) {
        continue
      }
      // A switch given no value is a flag that is on.
      entries.push([parts, value ?? 'true'])
      origins.set(parts.join('.'), origin)
    }

    return [{ name: this.name, data: buildTree(entries, this.name), origins }]
  }
}

/** The host's own command line, read through `globalThis` so a runtime without a `process` contributes nothing. */
export function hostArgv(): readonly string[] {
  return (globalThis as { process?: { argv?: readonly string[] } }).process?.argv ?? []
}

type Parsed = [path: string, value: string | undefined, origin: string]

/**
 * Reads the switches of a command line, up to `--`: `--a.b=v`, `--a.b v`, the `:` spelling, `--no-a.b` as `'false'`,
 * and the short switches `switchMappings` names. Each is a dotted path, its value or `undefined` for a switch given
 * none, and the argument it came from.
 */
export function parseArgv(argv: readonly string[], switchMappings: Record<string, string>): Parsed[] {
  const out: Parsed[] = []
  const add = (key: string, value: string | undefined, token: string): void => {
    out.push([key.split(':').join('.'), value, `args:${token}`])
  }

  // Configuration only ever lives in the flags, so the interpreter and script paths ahead of them are skipped.
  let i = 0
  while (i < argv.length && !argv[i].startsWith('-')) {
    i++
  }

  for (; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--') {
      break
    }

    const mapped = Object.hasOwn(switchMappings, token) ? switchMappings[token] : undefined
    if (mapped !== undefined) {
      const next = argv[i + 1]
      if (isValue(next, switchMappings)) {
        add(mapped, next, token)
        i++
      } else {
        add(mapped, undefined, token)
      }
      continue
    }

    if (!token.startsWith('--')) {
      // An unmapped short switch is not configuration.
      continue
    }

    const body = token.slice(2)
    const eq = body.indexOf('=')

    if (eq >= 0) {
      add(body.slice(0, eq), body.slice(eq + 1), token)
      continue
    }

    if (body.startsWith('no-')) {
      add(body.slice(3), 'false', token)
      continue
    }

    const next = argv[i + 1]
    if (isValue(next, switchMappings)) {
      add(body, next, token)
      i++
      continue
    }

    add(body, undefined, token)
  }

  return out
}

const NEGATIVE_NUMBER = /^-\.?\d/

/** Whether `token` is the value of the switch before it: not a switch itself, though a negative number is a value. */
function isValue(token: string | undefined, switchMappings: Record<string, string>): token is string {
  if (token === undefined) {
    return false
  }
  return !token.startsWith('-') || (NEGATIVE_NUMBER.test(token) && !Object.hasOwn(switchMappings, token))
}
