import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { hostPlatformPackage } from './binary.js'

/** The built modules that find and run the binary: what an installation runs, so the package must be built first. */
const MODULES = ['binary.js', 'launcher.js', '_err_message.gen.js']

export interface Installation {
  /** The installed `dist/binary.js`. */
  binary: string
  /** The installed `dist/launcher.js`, which npm links as the `caffeine` bin. */
  launcher: string
  /** The package an install brings for this platform, such as `@caffeinejs/cli-darwin-arm64`. */
  platformPackage: string
  /** Where that package holds the binary. */
  platformBinary: string
  /** Where a clone of the repository compiles the binary. */
  compiledBinary: string
}

/**
 * Installs `@caffeinejs/cli` under `dir/node_modules`, with `sh` scripts standing in for the binary: `platform` in
 * the package for this platform, and `compiled` beside the modules, where a clone of the repository compiles it.
 */
export async function install(
  dir: string,
  scripts: { platform?: string; compiled?: string } = {},
): Promise<Installation> {
  const cli = join(dir, 'node_modules', '@caffeinejs', 'cli')
  const name = hostPlatformPackage()
  const installation: Installation = {
    binary: join(cli, 'dist', 'binary.js'),
    launcher: join(cli, 'dist', 'launcher.js'),
    platformPackage: name,
    platformBinary: join(dir, 'node_modules', name, 'bin', 'caffeine'),
    compiledBinary: join(cli, 'dist', 'caffeine'),
  }

  await mkdir(join(cli, 'dist'), { recursive: true })
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@caffeinejs/cli', type: 'module' }))
  for (const module of MODULES) {
    await copyFile(join(import.meta.dirname, 'dist', module), join(cli, 'dist', module))
  }

  if (scripts.platform !== undefined) {
    await mkdir(join(dir, 'node_modules', name, 'bin'), { recursive: true })
    await writeScript(installation.platformBinary, scripts.platform)
  }
  if (scripts.compiled !== undefined) {
    await writeScript(installation.compiledBinary, scripts.compiled)
  }

  return installation
}

async function writeScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}
