import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the front end when it is not there.
 *
 * `web/dist` is build output and therefore not committed, but the specs serve real files from it — hashed
 * asset names, the compressed siblings `preCompressed` looks for, the root-level public files. Building it
 * here keeps the example self-sufficient wherever its vitest project runs, and no codegen leaks into the root
 * scripts. The module graph (`api/**\/*.gen.mod.ts`) is committed, so nothing regenerates that on a test run.
 */
export default function setup(): void {
  const cwd = dirname(fileURLToPath(import.meta.url))
  if (existsSync(join(cwd, 'web/dist/index.html'))) {
    return
  }

  execSync('npm run build:web', { cwd, stdio: 'inherit' })
}
