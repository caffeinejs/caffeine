// Compiles the caffeine binary from bin.ts, with the scaffold templates and the repository's ai/ pack embedded. In the
// binary every module's `import.meta.dirname` is its root, where each asset directory sits under its own name: the
// scaffold command finds templates/ beside it and ai/ by walking up, as it does in a checkout. The binary reads
// package.json files, which a compiled binary skips by default, so that a project's `.caffeinerc.ts` can import
// `@caffeinejs/cli` from the project's node_modules through its `exports`. `caffeine --version` prints the version in
// package.json, written in at compile time.
//
// Usage: bun tools/compile.ts [--outfile <path>] [--target <bun target, such as bun-linux-x64-musl>]
//                             [--executable-path <bun runtime for the target>] [--metafile <path>]
//
// Without --target the binary is for this machine. A Windows target appends .exe to the outfile. Without
// --executable-path Bun downloads the runtime for the target, or uses its own for this machine. --metafile writes Bun's
// list of every file the bundle holds.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const cli = join(import.meta.dirname, '..')

const { values } = parseArgs({
  options: {
    outfile: { type: 'string', default: join(cli, 'dist', 'caffeine') },
    target: { type: 'string' },
    'executable-path': { type: 'string' },
    metafile: { type: 'string' },
  },
})

const { version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')) as { version: string }

const result = await Bun.build({
  entrypoints: [join(cli, 'bin.ts')],
  define: { CAFFEINE_VERSION: JSON.stringify(version) },
  metafile: values.metafile !== undefined,
  compile: {
    outfile: resolve(values.outfile),
    ...(values.target === undefined ? {} : { target: values.target as Bun.Build.CompileTarget }),
    ...(values['executable-path'] === undefined ? {} : { executablePath: resolve(values['executable-path']) }),
    assets: [join(cli, 'command', 'scaffold', 'templates'), join(cli, '..', 'ai')],
    autoloadPackageJson: true,
  },
})

if (values.metafile !== undefined) {
  writeFileSync(resolve(values.metafile), JSON.stringify(result.metafile))
}
