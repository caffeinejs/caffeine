import { createRequire } from 'node:module'

import type { BootstrapKit } from './feature.js'
import { isTestEnvironment } from './shutdown/shutdown_options.js'

/**
 * What `.banner(...)` takes: `false` for none, the text itself, or a function building it from the application's
 * {@link BootstrapKit}. Left unset, the banner is the default one, which names the Caffeine and Node.js versions. It is
 * printed only when stdout is a terminal and no test runner is running (`NODE_ENV=test` or `VITEST`), so a pipe, a
 * file or a protocol spoken over stdout never reads it. A string or a function given to `.banner(...)` is printed
 * wherever stdout goes.
 *
 * `run()` prints it to stdout with `console.log` once the application is readied, before it starts: `bootstrap()`
 * alone prints none, and disabling the logger does not silence it. It never stops the application from starting: a
 * function that throws or returns anything but a string, and a stdout that throws, are logged as a warning.
 *
 * ```ts
 * .banner(({ config }) => `orders on port ${config.app.server.port}`)
 * ```
 */
export type Banner<C = unknown> = false | string | ((kit: BootstrapKit<C>) => string)

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
 * Prints `banner`, `undefined` being the default one. Nothing here can fail the start: what goes wrong is logged on
 * the kit's logger, and a logger that throws on that warning is ignored too.
 */
export function printBanner<C>(banner: Banner<C> | undefined, kit: BootstrapKit<C>): void {
  try {
    if (banner === false || (banner === undefined && (isTestEnvironment() || process.stdout.isTTY !== true))) {
      return
    }

    let text: unknown
    if (banner === undefined) {
      text = defaultBanner()
    } else if (typeof banner === 'string') {
      text = banner
    } else {
      text = banner(kit)
    }

    if (typeof text !== 'string') {
      // An async function, or a caller no type checked: what it returned is not printed, and a rejection it carries
      // is not left unhandled.
      void Promise.resolve(text).catch(() => undefined)
      kit.logger.warn('cannot print the banner: the banner function did not return a string')
      return
    }

    console.log(text)
  } catch (error) {
    try {
      kit.logger.warn({ err: error }, 'cannot print the banner')
    } catch {
      // The banner is not worth a failed start, and neither is a warning about it.
    }
  }
}

function defaultBanner(): string {
  const version = caffeineVersion()
  const detail = [version === undefined ? '' : `(v${version})`, `Node.js ${process.version}`]
    .filter(part => part !== '')
    .join('  ')
  // The detail ends where the art does, as long as the line has room for it.
  const gap = ' '.repeat(Math.max(2, WIDTH - LABEL.length - detail.length))

  return [...ART, `  ${'='.repeat(WIDTH - 2)}`, `${LABEL}${gap}${detail}`].join('\n')
}

function caffeineVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('@caffeinejs/application/package.json') as { version: string }).version
  } catch {
    // A bundle that left the manifest behind: the banner goes without the version rather than failing the start.
    return undefined
  }
}
