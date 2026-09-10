import { textList } from '../schema/text.js'

/**
 * Where the active-profile list lives in the configuration tree.
 *
 * The one location `std/config` knows by name. A feature never picks its own place in the tree, but the
 * profiles are read *before* anything resolves — there is no configuration yet to say where they are — so the
 * framework's own namespace is fixed here, the same way `std/application.ts` fixes `caffeine`.
 */
export const PROFILES_KEY = ['caffeine', 'profiles'] as const

const ARG_FLAGS = ['--caffeine.profiles', '--caffeine:profiles'] as const
const ENV_VAR = 'CAFFEINE__PROFILES'

/**
 * Normalizes a raw active-profile value into a unique list, in first-seen order.
 *
 * Accepts what a source actually produces: a string array from a file or the code band, or delimited text
 * (`CAFFEINE__PROFILES=eu,dev`) from an environment variable or a command-line argument. Blank entries are
 * dropped, and a profile named twice keeps only its first position, so no provider ever sees a duplicate.
 */
export function activeProfiles(raw: unknown, separator?: string): string[] {
  const split = textList(raw, separator)
  const list = Array.isArray(split) ? split : []
  const seen = new Set<string>()

  for (const entry of list) {
    if (typeof entry !== 'string') {
      continue
    }
    const profile = entry.trim()
    if (profile !== '') {
      seen.add(profile)
    }
  }

  return [...seen]
}

/**
 * The profiles named on the command line or in the environment, read straight from the host — no provider, no
 * merge, no resolve.
 *
 * This runs before configuration exists, which is the whole point: it is what lets a single resolve be
 * profile-aware instead of one probe pass followed by a real one. An argument wins over the environment, and
 * both go through {@link activeProfiles}, so `eu,dev` splits and dedupes exactly as a configured value would.
 *
 * Reading `process.argv` here is not the same opt-in {@link ArgsConfigProvider} is: exactly one flag is
 * matched, so a process whose switches were meant for something else contributes nothing.
 *
 * @param argv - Defaults to the host's own arguments. Present so a test need not touch the real process.
 * @param env - Defaults to the host's own environment, for the same reason.
 */
export function hostProfiles(argv: readonly string[] = hostArgv(), env = hostEnv()): string[] {
  return activeProfiles(argProfiles(argv) ?? env[ENV_VAR] ?? [])
}

/** `--caffeine.profiles=eu,dev`, `--caffeine.profiles eu,dev`, or the `:` spelling. Last occurrence wins. */
function argProfiles(argv: readonly string[]): string | undefined {
  let found: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--') {
      break
    }

    for (const flag of ARG_FLAGS) {
      if (token.startsWith(`${flag}=`)) {
        found = token.slice(flag.length + 1)
      } else if (token === flag) {
        const next = argv[i + 1]
        // A bare flag with nothing usable after it names no profile rather than the empty one.
        found = next !== undefined && !next.startsWith('-') ? next : undefined
      }
    }
  }

  return found
}

/** The host's own arguments, read through `globalThis` so this file carries no host binding of its own. */
function hostArgv(): readonly string[] {
  return (globalThis as { process?: { argv?: readonly string[] } }).process?.argv ?? []
}

/** The host's own environment, on the same terms. */
function hostEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}
