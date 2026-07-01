import { join } from 'node:path'

export interface ScanOptions {
  root: string
  include: string[]
  exclude: string[]
}

export async function scan(opts: ScanOptions): Promise<string[]> {
  const excludeGlobs = opts.exclude.map(p => new Bun.Glob(p))
  const seen = new Set<string>()

  for (const pattern of opts.include) {
    const glob = new Bun.Glob(pattern)
    for await (const rel of glob.scan({ cwd: opts.root, onlyFiles: true })) {
      if (!excludeGlobs.some(g => g.match(rel))) {
        seen.add(join(opts.root, rel))
      }
    }
  }

  return [...seen].sort()
}
