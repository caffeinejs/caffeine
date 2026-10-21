import { readFileSync } from 'node:fs'

import { CaffeineIoC, token } from '@caffeinejs/di'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Application, ErrApplicationStarted, createApplication } from './application.js'
import { InlineConfigSource } from './config/sources/inline/index.js'
import { newConfiguration } from './configuration.js'
import { kFeatureBootstrap, kFeatureConfigure, kFeatureName } from './feature.js'
import { newNoopLogger, type Logger } from './logger/index.js'
import { $t } from './schema/t.js'

const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
  .version

// The default banner is skipped under a test runner, the way signal handling is; these cases see what a host sees.
function outsideTestRunner(): void {
  vi.stubEnv('VITEST', undefined)
  vi.stubEnv('NODE_ENV', 'production')
}

function headless(logger?: Logger) {
  return createApplication({ container: new CaffeineIoC({ decorators: false }), logger }).shutdown(s =>
    s.signals(false),
  )
}

function recordingLogger(warnings: unknown[][]): Logger {
  return { ...newNoopLogger(), warn: (...args: unknown[]) => void warnings.push(args) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('the banner', () => {
  it('prints the default banner on run(), naming the Caffeine and Node.js versions', async () => {
    outsideTestRunner()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = headless()

    await app.run()

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

    await app.close()
  })

  // Every application a suite runs would print it otherwise.
  it('skips the default banner under a test runner', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = headless()

    await app.run()

    expect(log).not.toHaveBeenCalled()

    await app.close()
  })

  it('prints a banner given as text verbatim, under a test runner too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = headless().banner('hello')

    await app.run()

    expect(log.mock.calls).toEqual([['hello']])

    await app.close()
  })

  it('prints nothing for a banner turned off', async () => {
    outsideTestRunner()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = headless().banner(false)

    await app.run()

    expect(log).not.toHaveBeenCalled()

    await app.close()
  })

  it("hands a banner function the application's kit: its configuration and a container that resolves", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const kTeam = token<string>('banner.team')
    const container = new CaffeineIoC({ decorators: false })
    container.bind(kTeam, t => t.toValue('orders'))
    const conf = newConfiguration($t.Object({ greeting: $t.String() }))
      .source(new InlineConfigSource({ greeting: 'hi' }))
      .build().config
    const app = createApplication({ container, config: conf })
      .shutdown(s => s.signals(false))
      .banner(({ config, container }) => `${container.get(kTeam)} says ${config.greeting}`)

    await app.run()

    expect(log.mock.calls).toEqual([['orders says hi']])

    await app.close()
  })

  // `bootstrap()` alone is what the test client and tools do; the banner belongs to the process that serves.
  it('prints nothing on bootstrap(), and on the run() that follows, as the bootstrap() callback set it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = headless()

    await app.bootstrap((_, a) => {
      a.banner('late')
    })

    expect(log).not.toHaveBeenCalled()

    await app.run()

    expect(log.mock.calls).toEqual([['late']])

    await app.close()
  })

  it('prints once the application is readied, before it starts', async () => {
    const order: string[] = []
    vi.spyOn(console, 'log').mockImplementation(() => void order.push('banner'))

    class Platform extends Application {
      protected override start(): Promise<void> {
        order.push('start')
        return Promise.resolve()
      }
    }

    const app = new Platform({ container: new CaffeineIoC({ decorators: false }) }).banner('hello').install({
      [kFeatureName]: 'recorder',
      [kFeatureConfigure]() {
        // Nothing to bind.
      },
      [kFeatureBootstrap]() {
        order.push('bootstrap')
      },
    })

    await app.run()

    expect(order).toEqual(['bootstrap', 'banner', 'start'])

    await app.close()
  })

  it('refuses a banner once bootstrap() has started', async () => {
    const app = headless()
    const ready = app.bootstrap()

    expect(() => app.banner(false)).toThrow(ErrApplicationStarted)

    await ready
  })

  // A banner is cosmetic: whatever goes wrong with it, the application still has to start.
  describe('never stopping the start', () => {
    it('logs a banner function that throws, and starts', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const failure = new Error('no banner today')
      const warnings: unknown[][] = []
      const app = headless(recordingLogger(warnings)).banner(() => {
        throw failure
      })

      await expect(app.run()).resolves.toEqual({ name: '', profiles: [] })

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([[{ err: failure }, 'cannot print the banner']])

      await app.close()
    })

    it('logs a banner function that returns something other than a string, and starts', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnings: unknown[][] = []
      const app = headless(recordingLogger(warnings)).banner((() => 42) as never)

      await expect(app.run()).resolves.toEqual({ name: '', profiles: [] })

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([['cannot print the banner: the banner function did not return a string']])

      await app.close()
    })

    // Vitest fails the run on an unhandled rejection, so leaving this one unhandled would fail the suite.
    it('logs an async banner function, leaves its rejection handled, and starts', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnings: unknown[][] = []
      const app = headless(recordingLogger(warnings)).banner((() => Promise.reject(new Error('later'))) as never)

      await expect(app.run()).resolves.toEqual({ name: '', profiles: [] })

      expect(log).not.toHaveBeenCalled()
      expect(warnings).toEqual([['cannot print the banner: the banner function did not return a string']])

      await app.close()
    })

    it('logs a stdout that throws, and starts', async () => {
      const failure = new Error('EPIPE')
      vi.spyOn(console, 'log').mockImplementation(() => {
        throw failure
      })
      const warnings: unknown[][] = []
      const app = headless(recordingLogger(warnings)).banner('hello')

      await expect(app.run()).resolves.toEqual({ name: '', profiles: [] })

      expect(warnings).toEqual([[{ err: failure }, 'cannot print the banner']])

      await app.close()
    })

    it('starts when the logger throws on the warning as well', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const logger: Logger = {
        ...newNoopLogger(),
        warn: () => {
          throw new Error('logger down')
        },
      }
      const app = headless(logger).banner(() => {
        throw new Error('no banner today')
      })

      await expect(app.run()).resolves.toEqual({ name: '', profiles: [] })

      await app.close()
    })
  })
})
