import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The petstore has two generated, untracked artifacts its specs import: the Prisma client and
// `src/**/*.gen.mod.ts` (from `caffeine generate`). They are regenerated here so the example
// is self-sufficient wherever its vitest project runs — no codegen leaks into the root scripts.
// Skip when both already exist so a full `npm test` does not pay generate on every local loop.
// Force with `npm run generate -w @caffeinejs/example-petstore`.
export default function setup(): void {
  const cwd = dirname(fileURLToPath(import.meta.url))
  const generated = join(cwd, 'src/root.gen.mod.ts')
  const prismaClient = join(cwd, '../../node_modules/.prisma/client')
  if (existsSync(generated) && existsSync(prismaClient)) {
    return
  }
  execSync('npm run generate', { cwd, stdio: 'inherit' })
}
