import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { printBanner, type BannerContext } from './banner.js'
import { newNoopLogger, type Logger } from './logger/index.js'

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version

const unnamed = { name: '', profiles: [], config: {} }

// The default banner is skipped under a test runner, the way signal handling is; these cases see what a host sees.
function outsideTestRunner(): void {
  vi.stubEnv('VITEST', undefined)
  vi.stubEnv('NODE_ENV', 'production')
}

function recordingLogger(warnings: unknown[][]): Logger {
  return { ...newNoopLogger(), warn: (...args: unknown[]) => void warnings.push(args) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('printBanner', () => {
  it('prints the default banner, naming the Caffeine and Node.js versions', () => {
    outsideTestRunner()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printBanner(undefined, unnamed, newNoopLogger())

    const detail = `(v${version})  Node.js ${process.version}`
    const expected = [
      '     ( (',
      '      ) )',
      '  .________.        ______      ________     _                _______',
      '  |        |__     / ____/___ _/ __/ __/__  (_)___  ___      / / ___/',
      '  |        |  )   / /   / __ `/ /_/ /_/ _ \\/ / __ \\/ _ \\__  / /\\__ \\',
      '  |        |_/   / /___/ /_/ / __/ __/  __/ / / / /  __/ /_/ /___/ /',
      '   \\______/      \\____/\\__,_/_/ /_/  \\___/_/_/ /_/\\___/\\____//____/',
      '  ===================================================================',
      `  :: CaffeineJS ::${' '.repeat(69 - 18 - detail.length)}${detail}`,
    ].join('\n')
    expect(log.mock.calls).toEqual([[expected]])
  })

  // Every application a suite runs would print it otherwise.
  it('skips the default banner under a test runner', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printBanner(undefined, unnamed, newNoopLogger())

    expect(log).not.toHaveBeenCalled()
  })

  it('prints a banner given as text verbatim, under a test runner too', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printBanner('hello', unnamed, newNoopLogger())

    expect(log.mock.calls).toEqual([['hello']])
  })

  it('prints nothing for a banner turned off', () => {
    outsideTestRunner()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printBanner(false, unnamed, newNoopLogger())

    expect(log).not.toHaveBeenCalled()
  })

  it('hands a banner function the name, the profiles, the configuration and the Caffeine version', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const banner = ({ name, profiles, config, version }: BannerContext<{ greeting: string }>) =>
      `${name} ${profiles.join(',')} ${config.greeting} ${version}`

    printBanner(banner, { name: 'orders', profiles: ['eu'], config: { greeting: 'hi' } }, newNoopLogger())

    expect(log.mock.calls).toEqual([[`orders eu hi ${version}`]])
  })

  // A banner is cosmetic: whatever goes wrong with it, the application it belongs to still has to start.
  describe('never throwing', () => {
    it('logs a banner function that throws, and prints nothing', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const failure = new Error('no banner today')
      const warnings: unknown[][] = []

      printBanner(
        () => {
          throw failure
        },
        unnamed,
        recordingLogger(warnings),
      )

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([[{ err: failure }, 'cannot print the banner']])
    })

    it('logs a banner function that returns something other than a string, and prints nothing', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnings: unknown[][] = []

      printBanner((() => 42) as never, unnamed, recordingLogger(warnings))

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([['cannot print the banner: the banner function did not return a string']])
    })

    // Vitest fails the run on an unhandled rejection, so leaving this one unhandled would fail the suite.
    it('logs an async banner function, and leaves its rejection handled', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnings: unknown[][] = []

      printBanner((() => Promise.reject(new Error('later'))) as never, unnamed, recordingLogger(warnings))

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([['cannot print the banner: the banner function did not return a string']])
    })

    it('logs a stdout that throws', () => {
      const failure = new Error('EPIPE')
      vi.spyOn(console, 'log').mockImplementation(() => {
        throw failure
      })
      const warnings: unknown[][] = []

      printBanner('hello', unnamed, recordingLogger(warnings))

      expect(warnings).toEqual([[{ err: failure }, 'cannot print the banner']])
    })

    it('returns when the logger throws on the warning as well', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const logger: Logger = {
        ...newNoopLogger(),
        warn: () => {
          throw new Error('logger down')
        },
      }

      expect(() =>
        printBanner(
          () => {
            throw new Error('no banner today')
          },
          unnamed,
          logger,
        ),
      ).not.toThrow()
    })
  })
})
