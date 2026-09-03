export const DEFAULT_GRAPH_ROOT = 'src'
export const DEFAULT_DEPTH = 1
export const DEFAULT_MAX_DEPTH = 8
export const GENERATED_MOD_SUFFIX = '.generated.mod.ts'

export interface PartitionOptions {
  depth: number
  depths: Record<string, number>
  maxDepth: number
  skip: string[]
}

export function isGeneratedMod(rel: string): boolean {
  return rel.endsWith(GENERATED_MOD_SUFFIX)
}

export function isHandwrittenMod(rel: string): boolean {
  return rel.endsWith('.mod.ts') && !rel.endsWith(GENERATED_MOD_SUFFIX)
}

export function toRootRel(cwdRel: string, root: string): string | undefined {
  const normalizedRoot = root.replace(/\/+$/u, '')
  if (cwdRel === normalizedRoot) {
    return undefined
  }
  if (cwdRel.startsWith(normalizedRoot + '/')) {
    return cwdRel.slice(normalizedRoot.length + 1)
  }
  return undefined
}

export function isSkipped(rootRel: string, skip: string[]): boolean {
  for (const prefix of skip) {
    const normalized = prefix.replace(/\/+$/u, '')
    if (rootRel === normalized || rootRel.startsWith(normalized + '/')) {
      return true
    }
  }
  return false
}

export function dirOf(rootRel: string): string {
  const slash = rootRel.lastIndexOf('/')
  return slash === -1 ? '' : rootRel.slice(0, slash)
}

export function dirDepth(dirRel: string): number {
  if (!dirRel) {
    return 0
  }
  let depth = 1
  for (let i = 0; i < dirRel.length; i++) {
    if (dirRel.charCodeAt(i) === 47) {
      depth++
    }
  }
  return depth
}

export function exceedsMaxDepth(rootRel: string, maxDepth: number): boolean {
  return dirDepth(dirOf(rootRel)) > maxDepth
}

export function effectiveStopDepth(dirRel: string, depth: number, depths: Record<string, number>): number {
  let stop = depth
  if (!dirRel) {
    return stop
  }
  let prefix = ''
  const parts = dirRel.split('/')
  for (let i = 0; i < parts.length; i++) {
    prefix = prefix ? prefix + '/' + parts[i] : parts[i]
    const override = depths[prefix]
    if (override !== undefined) {
      stop = override
    }
  }
  return stop
}

export function moduleDir(dirRel: string, opts: { depth: number; depths: Record<string, number> }): string {
  if (!dirRel) {
    return ''
  }
  const parts = dirRel.split('/')
  const stop = effectiveStopDepth(dirRel, opts.depth, opts.depths)
  if (parts.length === stop) {
    return dirRel
  }
  if (parts.length > stop) {
    return parts.slice(0, stop).join('/')
  }
  return moduleDir(parts.slice(0, -1).join('/'), opts)
}

export function bucketFiles(rootRels: string[], opts: PartitionOptions): Map<string, string[]> {
  const buckets = new Map<string, string[]>()
  for (const rel of rootRels) {
    if (isSkipped(rel, opts.skip) || exceedsMaxDepth(rel, opts.maxDepth) || isGeneratedMod(rel)) {
      continue
    }
    const dir = moduleDir(dirOf(rel), opts)
    const list = buckets.get(dir)
    if (list) {
      list.push(rel)
    } else {
      buckets.set(dir, [rel])
    }
  }
  return buckets
}
