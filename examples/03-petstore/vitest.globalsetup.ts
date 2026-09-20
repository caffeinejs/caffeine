import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Prisma client is generated and untracked, and the specs import it. It is generated here so the example
// is self-sufficient wherever its vitest project runs — no codegen leaks into the root scripts. The module
// graph (`src/**/*.gen.mod.ts`) is committed, so nothing regenerates it on a test run; a change to the file
// layout is regenerated deliberately, with `npm run generate -w @caffeinejs/example-petstore`.
export default function setup(): void {
  const cwd = dirname(fileURLToPath(import.meta.url))
  const prismaClient = join(cwd, '../../node_modules/.prisma/client')
  if (existsSync(prismaClient)) {
    return
  }
  execSync('npm run prisma:generate', { cwd, stdio: 'inherit' })
}
