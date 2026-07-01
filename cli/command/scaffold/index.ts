import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { scaffold } from './scaffolder.js'

export const VALID_FLAVORS = ['http'] as const
export const VALID_ARCHS = ['3tier', 'usecase'] as const

export type Flavor = (typeof VALID_FLAVORS)[number]
export type Arch = (typeof VALID_ARCHS)[number]

export interface ScaffoldOptions {
  cwd: string
  flavor?: string
  arch?: string
  name?: string
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(() => true, () => false)
}

export async function run(opts: ScaffoldOptions): Promise<void> {
  if (!opts.name) {
    console.error('[caffeine] scaffold requires a project name: caffeine scaffold <name>')
    process.exit(1)
  }

  const flavor = opts.flavor ?? 'http'
  const arch = opts.arch ?? '3tier'

  if (!(VALID_FLAVORS as readonly string[]).includes(flavor)) {
    console.error(`[caffeine] Cannot scaffold: unknown flavor "${flavor}". Valid: ${VALID_FLAVORS.join(', ')}`)
    process.exit(1)
  }

  if (!(VALID_ARCHS as readonly string[]).includes(arch)) {
    console.error(`[caffeine] Cannot scaffold: unknown arch "${arch}". Valid: ${VALID_ARCHS.join(', ')}`)
    process.exit(1)
  }

  const templateDir = join(import.meta.dirname, 'templates', flavor, arch)

  const outDir = join(opts.cwd, opts.name)

  if (await exists(outDir)) {
    console.error(`[caffeine] Cannot scaffold: directory "${opts.name}" already exists`)
    process.exit(1)
  }

  await scaffold({ templateDir, outDir, projectName: opts.name })
  console.log(`[caffeine] scaffolded ${opts.name} → ${flavor}/${arch}`)
}
