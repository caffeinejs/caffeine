import { join } from 'node:path'

import { ErrConfig, messageOf } from './errors.js'
import { expandDotenv } from './interpolation.js'
import { PROFILES_VARIABLE } from './profiles.js'

/**
 * Loads dotenv files into `process.env`.
 *
 * It is handed files the most specific first: with `dev` then `prod` active, `.env.prod`, `.env.dev`, then `.env`.
 * The first file to set a variable wins, and a variable that is already set wins over every file, as
 * `process.loadEnvFile` and dotenv have it when handed the list as it is. A loader that overrides lets a file outrank
 * the environment the application was started with.
 *
 * It is called with the base file alone first, since that file may name the profiles, and, once a profile is active,
 * again with every file. A file that is not there is the loader's to skip.
 */
export type DotenvLoader = (filenames: string[]) => void | Promise<void>

export interface DotenvOptions {
  loader: DotenvLoader
  /** The directory the files are in. */
  path: string
  /**
   * Defaults to `.env`. A profile's file is the base name, a dot and the profile: `.env.dev`. The base file alone may
   * name the profiles, with `CAFFEINE_PROFILES`.
   */
  baseName?: string
  /**
   * Whether `${env:NAME}` in what the files set is expanded as they load. **Defaults to `true`.** A reference reads
   * another entry the files set, or else the environment; `${config:path}` is refused, since no source has loaded yet.
   * The expanded text is what `process.env` holds from then on.
   *
   * Turn it off for a loader that expands values itself, which would read a placeholder its own way, or to take the
   * files as written.
   */
  interpolate?: boolean
}

/**
 * Loads the dotenv files and settles the profiles with them: the base file first, then the profiles `profilesOf`
 * reads, then the files of those profiles. What the files set is expanded once every file has loaded, and
 * `CAFFEINE_PROFILES` as soon as the base file has, since it names the profiles.
 *
 * @throws ErrConfig `ERR_CONFIG_DOTENV` when the loader throws, with what it threw as the cause.
 * @throws ErrConfig `ERR_CONFIG_INTERPOLATION` when what the files set cannot be expanded.
 */
export async function loadDotenv(options: DotenvOptions, profilesOf: () => string[]): Promise<string[]> {
  const env = process.env
  const before = new Map(Object.entries(env))
  const base = join(options.path, options.baseName ?? '.env')

  await load(options, [base])
  // The rest of the base may read a variable that only the file of a profile sets.
  expand(options, before, env, [PROFILES_VARIABLE])
  const profiles = profilesOf()

  if (profiles.length > 0) {
    // A profile's file outranks the base, and the first file to set a variable wins: what the base set is taken
    // back, and the base is read again after the files of the profiles.
    for (const name of changed(before, env).keys()) {
      const previous = before.get(name)
      if (previous === undefined) {
        delete env[name]
      } else {
        env[name] = previous
      }
    }

    await load(options, [...profiles.toReversed().map(profile => `${base}.${profile}`), base])
  }

  expand(options, before, env)
  return profiles
}

/**
 * Writes back what the files set with its placeholders expanded, unless told to take the files as written: `names`
 * and what they read, or every entry.
 */
function expand(
  options: DotenvOptions,
  before: ReadonlyMap<string, string | undefined>,
  env: Record<string, string | undefined>,
  names?: readonly string[],
): void {
  if (options.interpolate === false) {
    return
  }

  const entries = changed(before, env)
  for (const [name, value] of expandDotenv(entries, env, options.path, names ?? entries.keys())) {
    env[name] = value
  }
}

async function load(options: DotenvOptions, filenames: string[]): Promise<void> {
  try {
    await options.loader(filenames)
  } catch (error) {
    throw error instanceof ErrConfig
      ? error
      : new ErrConfig(
          `Cannot load the dotenv files in "${options.path}": ${messageOf(error)}`,
          'ERR_CONFIG_DOTENV',
          error,
          'Check that every dotenv file there can be read',
        )
  }
}

/** Every variable the environment holds now with a value it did not hold before. */
function changed(
  before: ReadonlyMap<string, string | undefined>,
  env: Readonly<Record<string, string | undefined>>,
): Map<string, string> {
  const out = new Map<string, string>()

  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && before.get(name) !== value) {
      out.set(name, value)
    }
  }

  return out
}
