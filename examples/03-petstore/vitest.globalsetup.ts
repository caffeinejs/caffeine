import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The petstore has two generated, untracked artifacts its specs import: the Prisma client and
// `src/__caffeine__.gen.ts` (from `caffeine generate`). They are regenerated here so the example
// is self-sufficient wherever its vitest project runs — no codegen leaks into the root scripts.
export default function setup(): void {
  const cwd = dirname(fileURLToPath(import.meta.url))
  execSync('npm run generate', { cwd, stdio: 'inherit' })
}
