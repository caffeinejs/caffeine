import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'

export interface ScanOptions {
  root: string
  include: string[]
  exclude: string[]
}

export async function scan(opts: ScanOptions): Promise<string[]> {
  const matchInclude = picomatch(opts.include)
  const matchExclude = opts.exclude.length > 0 ? picomatch(opts.exclude) : () => false

  const entries = await readdir(opts.root, { recursive: true, withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const abs = join(entry.parentPath, entry.name)
    const rel = relative(opts.root, abs).replaceAll('\\', '/')

    if (matchInclude(rel) && !matchExclude(rel)) {
      results.push(abs)
    }
  }

  return results.sort()
}
