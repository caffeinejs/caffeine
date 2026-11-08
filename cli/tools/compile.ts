// Compiles the caffeine binary from bin.ts, with the scaffold templates and the repository's ai/ pack embedded. In the
// binary every module's `import.meta.dirname` is its root, where each asset directory sits under its own name: the
// scaffold command finds templates/ beside it and ai/ by walking up, as it does in a checkout. The binary reads
// package.json files, which a compiled binary skips by default, so that a project's `.caffeinerc.ts` can import
// `@caffeinejs/cli` from the project's node_modules through its `exports`.
//
// Usage: bun tools/compile.ts [--outfile <path>]

import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const cli = join(import.meta.dirname, '..')

const { values } = parseArgs({
  options: {
    outfile: { type: 'string', default: join(cli, 'dist', 'caffeine') },
  },
})

await Bun.build({
  entrypoints: [join(cli, 'bin.ts')],
  compile: {
    outfile: resolve(values.outfile),
    assets: [join(cli, 'command', 'scaffold', 'templates'), join(cli, '..', 'ai')],
    autoloadPackageJson: true,
  },
})
