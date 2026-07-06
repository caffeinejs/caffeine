import { join } from 'node:path'

export interface ScanOptions {
  root: string
  include: string[]
  exclude: string[]
}

const DECORATOR_RE = /(?:^|\n)\s*@[A-Za-z]/

export async function scan(opts: ScanOptions): Promise<string[]> {
  const excludeGlobs = opts.exclude.map(p => new Bun.Glob(p))
  const seen = new Set<string>()

  for (const pattern of opts.include) {
    const glob = new Bun.Glob(pattern)
    for await (const rel of glob.scan({ cwd: opts.root, onlyFiles: true })) {
      if (!excludeGlobs.some(g => g.match(rel))) {
        const abs = join(opts.root, rel)
        if (await hasDecorator(abs)) {
          seen.add(abs)
        }
      }
    }
  }

  return [...seen].sort()
}

async function hasDecorator(filePath: string): Promise<boolean> {
  const decoder = new TextDecoder('utf-8')
  let tail = ''
  for await (const chunk of Bun.file(filePath).stream()) {
    const text = tail + decoder.decode(chunk, { stream: true })
    if (DECORATOR_RE.test(text)) {
      return true
    }
    tail = text.length > 32 ? text.slice(-32) : text
  }
  return false
}
