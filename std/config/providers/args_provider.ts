import type { ConfigEntry, ConfigProvider, PropertySource, ResolutionContext } from '../config.js'
import { coerceText } from './_coerce.js'

export interface ArgsConfigProviderOptions {
  /**
   * The arguments to read. Omitted, the host's own are used — `process.argv` where there is a `process`,
   * nothing where there is not.
   *
   * Adding this provider at all is the opt-in, so nothing reads a command line unless the application asked
   * for command-line configuration. The one case left to know about is a process whose flags were meant for
   * something else: an application that calls `.args()` and is then booted inside a test runner reads that
   * runner's switches. Pass an explicit array wherever that matters.
   */
  argv?: readonly string[]
  /** Short-switch expansions, e.g. `{ '-p': 'server.port' }`. */
  switchMappings?: Record<string, string>
}

/**
 * Configuration from command-line arguments — call `.args()` after the other sources so a single run can be
 * redirected without touching the environment it runs in.
 *
 * Accepted forms:
 *
 * | Argument                   | Result                              |
 * |----------------------------|-------------------------------------|
 * | `--server.port=8080`       | `server.port` = `8080`              |
 * | `--server.port 8080`       | `server.port` = `8080`              |
 * | `--server:port=8080`       | `server.port` = `8080`              |
 * | `--server.verbose`         | `server.verbose` = `true`           |
 * | `--no-server.verbose`      | `server.verbose` = `false`          |
 * | `-p 8080` (mapped)         | `server.port` = `8080`              |
 * | `--`                       | stops parsing; the rest is the app's |
 *
 * Everything before the first `-`-prefixed token is skipped, which is what lets `process.argv`
 * (`[execPath, script, ...]`), `process.argv.slice(2)` and `Deno.args` all be passed as-is with no ceremony
 * and no host detection. Positional arguments ahead of the flags are not configuration and are dropped.
 *
 * Values coerce exactly as environment variables do, so moving a setting between the two cannot change its type.
 */
export class ArgsConfigProvider implements ConfigProvider {
  readonly id = 'args'
  readonly #argv: readonly string[] | undefined
  readonly #switchMappings: Record<string, string>

  constructor(options: ArgsConfigProviderOptions = {}) {
    this.#argv = options.argv
    this.#switchMappings = options.switchMappings ?? {}
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    const argv = this.#argv ?? hostArgv()
    const entries = new Map<string, ConfigEntry>()

    for (const [key, value, origin] of parse(argv, this.#switchMappings)) {
      entries.set(key, { key, value: coerceText(value), origin })
    }

    return [{ name: 'args', entries }]
  }
}

/**
 * The host's own command line, read through `globalThis` so this file has no host binding of its own. A
 * runtime without a `process` contributes nothing rather than failing.
 */
function hostArgv(): readonly string[] {
  return (globalThis as { process?: { argv?: readonly string[] } }).process?.argv ?? []
}

type Parsed = [key: string, value: string, origin: string]

function parse(argv: readonly string[], switchMappings: Record<string, string>): Parsed[] {
  const out: Parsed[] = []

  // Skip the leading positional tokens — the interpreter path and script path when `process.argv` was handed
  // over whole. Configuration only ever lives in the flags.
  let i = 0
  while (i < argv.length && !argv[i].startsWith('-')) {
    i++
  }

  for (; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--') {
      break
    }

    const mapped = switchMappings[token]
    if (mapped !== undefined) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        out.push([normalizeKey(mapped), next, `args:${token}`])
        i++
      } else {
        out.push([normalizeKey(mapped), 'true', `args:${token}`])
      }
      continue
    }

    if (!token.startsWith('--')) {
      // An unmapped short switch is not ours — a bare positional is not configuration either.
      continue
    }

    const body = token.slice(2)
    const eq = body.indexOf('=')

    if (eq >= 0) {
      out.push([normalizeKey(body.slice(0, eq)), body.slice(eq + 1), `args:${token}`])
      continue
    }

    if (body.startsWith('no-')) {
      out.push([normalizeKey(body.slice(3)), 'false', `args:${token}`])
      continue
    }

    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      out.push([normalizeKey(body), next, `args:${token}`])
      i++
      continue
    }

    out.push([normalizeKey(body), 'true', `args:${token}`])
  }

  return out
}

/** `:` is accepted as a separator alongside `.`, matching how the same keys are written in other tooling. */
function normalizeKey(key: string): string {
  return key.split(':').join('.')
}
