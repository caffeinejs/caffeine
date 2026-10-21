import { createRequire } from 'node:module'

import type { ConfigSnapshot } from './config/index.js'
import type { Logger } from './logger/logger.js'
import { isTestEnvironment } from './shutdown/shutdown_options.js'

/** What a banner function is handed: the application as its configuration resolved it. */
export interface BannerContext<C = unknown> {
  /** The application name from `caffeine.name`. */
  readonly name: string
  /** The active configuration profiles. */
  readonly profiles: readonly string[]
  /** The configuration the application is starting with. */
  readonly config: ConfigSnapshot<C>
  /** The version of `@caffeinejs/application`, or `undefined` where its manifest cannot be read, as in a bundle. */
  readonly version: string | undefined
}

/** What `.banner(...)` takes: `false` for none, the text itself, or a function that builds it. */
export type Banner<C = unknown> = false | string | ((context: BannerContext<C>) => string)

// A cup beside figlet's slant "CaffeineJS". Lines rather than a template literal: the art holds a backtick.
const ART = [
  '     ( (',
  '      ) )',
  '  .________.        ______      ________     _                _______',
  '  |        |__     / ____/___ _/ __/ __/__  (_)___  ___      / / ___/',
  '  |        |  )   / /   / __ `/ /_/ /_/ _ \\/ / __ \\/ _ \\__  / /\\__ \\',
  '  |        |_/   / /___/ /_/ / __/ __/  __/ / / / /  __/ /_/ /___/ /',
  '   \\______/      \\____/\\__,_/_/ /_/  \\___/_/_/ /_/\\___/\\____//____/',
]

const WIDTH = 69
const LABEL = '  :: CaffeineJS ::'

/**
 * Prints `banner` to stdout, `undefined` being the default one, which a test runner does not get. Nothing here can
 * fail the start: whatever the banner function, the version lookup or stdout throws is logged as a warning, and a
 * logger that throws on that warning is ignored too.
 */
export function printBanner<C>(
  banner: Banner<C> | undefined,
  application: Omit<BannerContext<C>, 'version'>,
  logger: Logger,
): void {
  try {
    if (banner === false || (banner === undefined && isTestEnvironment())) {
      return
    }

    const context: BannerContext<C> = { ...application, version: caffeineVersion() }

    let text: unknown
    if (banner === undefined) {
      text = defaultBanner(context.version)
    } else if (typeof banner === 'string') {
      text = banner
    } else {
      text = banner(context)
    }

    if (typeof text !== 'string') {
      // An async function, or a caller no type checked: what it returned is not printed, and a rejection it carries
      // is not left unhandled.
      void Promise.resolve(text).catch(() => undefined)
      logger.warn('cannot print the banner: the banner function did not return a string')
      return
    }

    console.log(text)
  } catch (error) {
    try {
      logger.warn({ err: error }, 'cannot print the banner')
    } catch {
      // The banner is not worth a failed start, and neither is a warning about it.
    }
  }
}

function caffeineVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@caffeinejs/application/package.json') as { version: string }).version
  } catch {
    // A bundle that left the manifest behind: the banner goes without the version rather than failing the start.
    return undefined
  }
}

function defaultBanner(version: string | undefined): string {
  const node = (globalThis as { process?: { version?: string } }).process?.version
  const detail = [version === undefined ? '' : `(v${version})`, node === undefined ? '' : `Node.js ${node}`]
    .filter(part => part !== '')
    .join('  ')
  // The detail ends where the art does, as long as the line has room for it.
  const gap = ' '.repeat(Math.max(2, WIDTH - LABEL.length - detail.length))

  return [...ART, `  ${'='.repeat(WIDTH - 2)}`, `${LABEL}${gap}${detail}`.trimEnd()].join('\n')
}
