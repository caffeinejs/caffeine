import { errMessage } from '../framework/err/index.js'
import { textList } from '../schema/text.js'
import { ErrConfig } from './errors.js'
import { hostArgv, parseArgv } from './sources/argv/argv.js'

const ARG_PATH = 'caffeine.profiles'

/** The environment variable that names the profiles. */
export const PROFILES_VARIABLE = 'CAFFEINE_PROFILES'

/**
 * Normalizes a raw active-profile value into a unique list, in first-seen order.
 *
 * Accepts a string array, as code names them, or delimited text (`CAFFEINE_PROFILES=eu,dev`), as an environment
 * variable or a command-line argument does. Blank entries are dropped, and a profile named twice keeps only its
 * first position, so no source ever sees a duplicate.
 *
 * @throws ErrConfig `ERR_CONFIG_PROFILE` when a profile is `.` or `..`, or holds `/` or `\`.
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
    if (profile === '') {
      continue
    }
    // A file source makes a file name of a profile, and a config server a segment of its request path.
    if (profile === '.' || profile === '..' || /[/\\]/.test(profile)) {
      throw new ErrConfig(
        errMessage(`Cannot use profile "${profile}": a profile name cannot be "." or "..", or contain "/" or "\\"`)
          .solutions('Name the profile with letters, digits, "-", "_" and "."')
          .reference('@caffeinejs/std', ErrConfig)
          .build(),
        'ERR_CONFIG_PROFILE',
      )
    }
    seen.add(profile)
  }

  return [...seen]
}

/**
 * The profiles `--caffeine.profiles` or `CAFFEINE_PROFILES` name, read straight from the host — no source, no
 * merge, no load.
 *
 * This runs before any source loads, which is the whole point: it is what lets a single load be profile-aware
 * instead of one probe pass followed by a real one. `loadConfig` calls it once the base dotenv file has loaded, so a
 * `CAFFEINE_PROFILES` set there counts. An argument wins over the environment, and both go through
 * {@link activeProfiles}: `eu,dev` names two profiles, and a repeated one counts once.
 *
 * Reading `process.argv` here is not the same opt-in {@link ArgvConfigSource} is: exactly one flag is
 * matched, so a process whose switches were meant for something else contributes nothing.
 *
 * @param argv - Defaults to the host's own arguments. Present so a test need not touch the real process.
 * @param env - Defaults to the host's own environment, for the same reason.
 */
export function hostProfiles(argv: readonly string[] = hostArgv(), env = hostEnv()): string[] {
  return activeProfiles(argProfiles(argv) ?? env[PROFILES_VARIABLE] ?? [])
}

/**
 * `--caffeine.profiles=eu,dev`, `--caffeine.profiles eu,dev`, or the `:` spelling, read as {@link ArgvConfigSource}
 * reads any switch. Last occurrence wins.
 */
function argProfiles(argv: readonly string[]): string | undefined {
  let found: string | undefined

  for (const [path, value] of parseArgv(argv, {})) {
    if (path === ARG_PATH) {
      // A bare flag names no profile rather than the empty one.
      found = value
    }
  }

  return found
}

/** The host's own environment, read through `globalThis` so this file carries no host binding of its own. */
function hostEnv(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}
