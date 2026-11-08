import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TestProject } from 'vitest/node'

import { buildStatic } from '../build/index.js'

/** The fixture directories every test reads, each built by `buildStatic` once per run. */
export interface BuiltFixtures {
  /** A built single-page application: `index.html` with `<div id="root">`, hashed assets and `favicon.svg`. */
  readonly spa: string
  /** A second built site, for an administration shell: `<div id="admin-root">` and `assets/admin-Zz9.js`. */
  readonly admin: string
  /** Plain files: `hello.txt` and `style.css`. */
  readonly fixtures: string
  /** A directory holding no `index.html`: `other.txt`. */
  readonly fixtures2: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    fixtures: BuiltFixtures
  }
}

const NAMES = ['spa', 'admin', 'fixtures', 'fixtures2'] as const

/**
 * Copies the committed fixtures into a temporary directory and builds each there, so variants and manifests are never
 * committed and every scenario serves what the build writes.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'caffeine-static-'))
  const built: Record<string, string> = {}

  for (const name of NAMES) {
    const root = join(dir, name)
    await cp(fileURLToPath(new URL(`_testdata/${name}`, import.meta.url)), root, { recursive: true })
    await buildStatic({ root })
    built[name] = root
  }

  project.provide('fixtures', built as unknown as BuiltFixtures)

  return () => rm(dir, { recursive: true, force: true })
}
