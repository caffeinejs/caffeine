import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Compiles the example before its specs run.
 *
 * Watt loads each application's entry module itself, in a worker thread and outside Vite, so what the runtime spec
 * runs is `dist/`. Compiling every time is what keeps a stale `dist/` from passing for code that has since changed.
 */
export default function setup(): void {
  execSync('npm run build', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'inherit' })
}
