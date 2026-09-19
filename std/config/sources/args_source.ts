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

  /** @throws ErrConfig `ERR_CONFIG_ARRAY_INDICES` or `ERR_CONFIG_KEY_CONFLICT` when two arguments disagree. */
  load(): readonly ConfigLayer[] {
    const entries: [string[], string][] = []
    const origins = new Map<string, string>()

    for (const [key, value, origin] of parse(this.#argv ?? hostArgv(), this.#switchMappings)) {
      const parts = splitKey(key.split(':').join('.'))
      if (parts.includes('')) {
        continue
      }
      entries.push([parts, value])
      origins.set(parts.join('.'), origin)
    }

    return [{ name: this.name, data: buildTree(entries, this.name), origins }]
  }
}

/** The host's own command line, read through `globalThis` so a runtime without a `process` contributes nothing. */
function hostArgv(): readonly string[] {
  return (globalThis as { process?: { argv?: readonly string[] } }).process?.argv ?? []
}

type Parsed = [key: string, value: string, origin: string]

function parse(argv: readonly string[], switchMappings: Record<string, string>): Parsed[] {
  const out: Parsed[] = []

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
        out.push([mapped, next, `args:${token}`])
        i++
      } else {
        out.push([mapped, 'true', `args:${token}`])
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
      out.push([body.slice(0, eq), body.slice(eq + 1), `args:${token}`])
      continue
    }

    if (body.startsWith('no-')) {
      out.push([body.slice(3), 'false', `args:${token}`])
      continue
    }

    const next = argv[i + 1]
    if (isValue(next, switchMappings)) {
      out.push([body, next, `args:${token}`])
      i++
      continue
    }

    out.push([body, 'true', `args:${token}`])
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
