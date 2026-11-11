import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { errMessage } from './_err_message.gen.js'

/** The caffeine binary could not be found: the package that holds it for this platform is not installed. */
export class ErrBinaryNotFound extends Error {
  readonly code = 'ERR_BINARY_NOT_FOUND'

  constructor(packageName: string) {
    super(
      errMessage(
        `Cannot find the caffeine binary: "${packageName}", which holds it for this platform, is not installed`,
      )
        .solutions(
          `Reinstall @caffeinejs/cli without --omit=optional or --no-optional, which skip "${packageName}"`,
          "Run caffeine on a platform listed in @caffeinejs/cli's optionalDependencies",
          'In a clone of the Caffeine repository, run npm run build:cli',
        )
        .reference('@caffeinejs/cli', ErrBinaryNotFound)
        .build(),
    )
    this.name = 'ErrBinaryNotFound'
  }
}

/** The package that holds the caffeine binary for a platform, such as `@caffeinejs/cli-linux-x64-musl`. */
export function platformPackage(platform: string, arch: string, musl: boolean): string {
  return `@caffeinejs/cli-${platform}-${arch}${musl ? '-musl' : ''}`
}

/** Whether a process report comes from a Linux whose C library is musl: only glibc reports its runtime version. */
export function isMusl(report: unknown): boolean {
  const { header } = report as { header?: { glibcVersionRuntime?: string } }
  return header?.glibcVersionRuntime === undefined
}

/** The package that holds the caffeine binary for the platform this process runs on. */
export function hostPlatformPackage(): string {
  return platformPackage(process.platform, process.arch, process.platform === 'linux' && runsOnMusl())
}

let resolved: string | undefined

/**
 * Returns the path of the caffeine binary for this platform, which the optional dependency of `@caffeinejs/cli` that
 * matches the platform holds.
 *
 * @throws {@link ErrBinaryNotFound} when that dependency is not installed
 */
export function resolveBinary(): string {
  resolved ??= locateBinary()
  return resolved
}

function locateBinary(): string {
  const name = hostPlatformPackage()
  const file = process.platform === 'win32' ? 'caffeine.exe' : 'caffeine'

  try {
    return createRequire(import.meta.url).resolve(`${name}/bin/${file}`)
  } catch (err) {
    // Only a missing package goes on: any other failure says why an installed one cannot be resolved.
    if ((err as { code?: unknown }).code !== 'MODULE_NOT_FOUND') {
      throw err
    }
    // A clone of the repository installs no platform package: `npm run build:cli` compiles the binary here.
    const compiled = join(import.meta.dirname, file)
    if (existsSync(compiled)) {
      return compiled
    }
  }

  throw new ErrBinaryNotFound(name)
}

function runsOnMusl(): boolean {
  // A report otherwise looks up the host of every open socket, which stalls a busy process such as a dev server.
  const report = process.report as typeof process.report & { excludeNetwork: boolean }
  const { excludeNetwork } = report
  report.excludeNetwork = true
  try {
    return isMusl(report.getReport())
  } finally {
    report.excludeNetwork = excludeNetwork
  }
}
