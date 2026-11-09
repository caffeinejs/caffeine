// Compiles the caffeine binary from bin.ts, with the scaffold templates and the repository's ai/ pack embedded. In the
// binary every module's `import.meta.dirname` is its root, where each asset directory sits under its own name: the
// scaffold command finds templates/ beside it and ai/ by walking up, as it does in a checkout. The binary reads
// package.json files, which a compiled binary skips by default, so that a project's `.caffeinerc.ts` can import
// `@caffeinejs/cli` from the project's node_modules through its `exports`. `caffeine --version` prints the version in
// package.json, written in at compile time.
//
// Usage: bun tools/compile.ts [--outfile <path>] [--target <bun target, such as bun-linux-x64-musl>]
//
// Without --target the binary is for this machine. A Windows target appends .exe to the outfile.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const cli = join(import.meta.dirname, '..')

const { values } = parseArgs({
  options: {
    outfile: { type: 'string', default: join(cli, 'dist', 'caffeine') },
    target: { type: 'string' },
  },
})

const { version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')) as { version: string }

await Bun.build({
  entrypoints: [join(cli, 'bin.ts')],
  define: { CAFFEINE_VERSION: JSON.stringify(version) },
  compile: {
    outfile: resolve(values.outfile),
    ...(values.target === undefined ? {} : { target: values.target as Bun.Build.CompileTarget }),
    assets: [join(cli, 'command', 'scaffold', 'templates'), join(cli, '..', 'ai')],
    autoloadPackageJson: true,
  },
})
