import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ErrCannotLoadTypeScriptModule } from '../errors.js'
import { Runtime } from './_runtime.js'

export type SinglePathFilter = string | RegExp | ((path: string) => boolean)
export type PathFilter = SinglePathFilter | SinglePathFilter[]

export type ScanOptions = {
  dir: string
  exclude?: string | URL | (string | URL)[]
  matchFilter?: PathFilter
  ignoreFilter?: PathFilter
  ignorePattern?: RegExp
  scriptPattern?: RegExp
  maxDepth?: number
  forceESM?: boolean
}

type ModuleEntry = {
  file: string
  type: 'module' | 'commonjs'
}

type ResolvedDefaultFinderOptions = Required<Pick<ScanOptions, 'scriptPattern' | 'maxDepth'>>
  & Pick<ScanOptions, 'matchFilter' | 'ignoreFilter' | 'ignorePattern'>

const packageTypeCache = new Map<string, string | undefined>()

const DEFAULT_SCRIPT_PATTERN = /(?:(?:^.?|\.[^d]|[^.]d|[^.][^d])\.ts|\.js|\.cjs|\.mjs|\.cts|\.mts|\.tsx|\.jsx)$/iu
const DEFAULT_IGNORE_FILTER = /\.(?:spec|test|e2e|bench)\.(?:[mc]?[jt]sx?)$|_test\.(?:[mc]?[jt]sx?)$/iu

const EXTENSION_PRIORITY = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const TYPESCRIPT_PATTERN = /\.(?:ts|mts|cts|tsx)$/iu
const MODULE_PATTERN = /\.(?:mjs|mts)$/iu
const COMMONJS_PATTERN = /\.(?:cjs|cts)$/iu
const DEFAULTS = {
  scriptPattern: DEFAULT_SCRIPT_PATTERN,
  ignorePattern: /^\.|^node_modules$/u,
  ignoreFilter: DEFAULT_IGNORE_FILTER as PathFilter,
  maxDepth: Number.POSITIVE_INFINITY,
}

/**
 * Scans the directories, automatically loading modules.
 * It simply loads the modules, without any additional processing.
 * By loading the modules, the decorators are evaluated and the bindings become visible to containers.
 *
 * @param options - The scan options.
 * @returns The list of files loaded by the scanner.
 *
 * @experimental
 */
export function scan(options: ScanOptions): Promise<string[]>
/**
 * Scans the directories, automatically loading modules.
 * It simply loads the modules, without any additional processing.
 * By loading the modules, the decorators are evaluated and the bindings become visible to containers.
 *
 * @param files - The files to scan.
 * @param options - The optional scan options.
 * @returns The list of files loaded by the scanner.
 *
 * @experimental
 */
export function scan(
  files: string | string[] | Promise<string> | Promise<string[]>,
  options?: Pick<ScanOptions, 'forceESM'>,
): Promise<string[]>
/**
 * Scans the directories, automatically loading modules.
 * It simply loads the modules, without any additional processing.
 * By loading the modules, the decorators are evaluated and the bindings become visible to containers.
 *
 * @param input - The input options or the files to scan.
 * @param options - The optional scan options.
 * @returns The list of files loaded by the scanner.
 *
 * @experimental
 */
export async function scan(
  input: ScanOptions | string | string[] | Promise<string> | Promise<string[]>,
  options?: Pick<ScanOptions, 'forceESM'>,
): Promise<string[]> {
  if (isScanOptions(input)) {
    const forceESM = input.forceESM ?? true
    const pkgType = forceESM ? Promise.resolve(undefined) : getPackageType(input.dir)
    return runScan(defaultFinder(input.dir, input), pkgType, input.exclude, forceESM)
  }

  const { forceESM = true } = options ?? {}
  const resolved = await Promise.resolve(input).then(f => (Array.isArray(f) ? f : [f]))
  if (resolved.length === 0) {
    return []
  }

  return runScan(
    Promise.resolve(resolved),
    forceESM ? Promise.resolve(undefined) : getPackageType(dirname(resolved[0])),
    undefined,
    forceESM,
  )
}

function isScanOptions(input: unknown): input is ScanOptions {
  return typeof input === 'object' && input !== null && !Array.isArray(input) && !(input instanceof Promise)
}

function deduplicateByBasename(files: string[]): string[] {
  const byBasename = new Map<string, string>()

  for (const file of files) {
    const ext = extname(file)
    const stem = file.slice(0, -ext.length)
    const existing = byBasename.get(stem)

    if (!existing) {
      byBasename.set(stem, file)
      continue
    }

    const existingPriority = EXTENSION_PRIORITY.indexOf(extname(existing))
    const currentPriority = EXTENSION_PRIORITY.indexOf(ext)

    if (currentPriority !== -1 && (existingPriority === -1 || currentPriority < existingPriority)) {
      byBasename.set(stem, file)
    }
  }

  return [...byBasename.values()]
}

async function runScan(
  finderPromise: Promise<string[]>,
  packageTypePromise: Promise<string | undefined>,
  exclude: ScanOptions['exclude'],
  esm: boolean,
): Promise<string[]> {
  const [packageType, files] = await Promise.all([packageTypePromise, finderPromise])
  const deduped = deduplicateByBasename(files)
  const excludeFiles = normalizeExclude(exclude)

  const entries: ModuleEntry[] = deduped
    .filter(file => !excludeFiles.has(file))
    .map(file => {
      handleTypeScriptSupport(file)
      return { file, type: determineModuleType(file, packageType) }
    })

  return loadModules(entries, esm)
}

async function defaultFinder(dir: string, options: ScanOptions): Promise<string[]> {
  const opts = { ...DEFAULTS, ...options }
  const files: string[] = []

  await buildTree(files, dir, { opts, depth: 0, rootDir: dir })

  return files
}

function normalizeExclude(exclude: ScanOptions['exclude']): Set<string> {
  if (exclude === undefined) {
    return new Set()
  }

  const items = Array.isArray(exclude) ? exclude : [exclude]

  return new Set(
    items.map(item => {
      if (item instanceof URL) {
        return fileURLToPath(item)
      }

      if (typeof item === 'string' && item.startsWith('file://')) {
        return fileURLToPath(item)
      }

      return item
    }),
  )
}

async function buildTree(
  files: string[],
  dir: string,
  ctx: { opts: ResolvedDefaultFinderOptions, depth: number, rootDir: string },
): Promise<void> {
  const { opts, depth, rootDir } = ctx
  const dirEntries = await readdir(dir, { withFileTypes: true })
  const subdirPromises: Promise<void>[] = []

  for (const dirEntry of dirEntries) {
    if (opts.ignorePattern && opts.ignorePattern.test(dirEntry.name)) {
      continue
    }

    const atMaxDepth = Number.isFinite(opts.maxDepth) && opts.maxDepth <= depth
    const file = join(dir, dirEntry.name)

    if (dirEntry.isDirectory() && !atMaxDepth) {
      subdirPromises.push(buildTree(files, file, { opts, depth: depth + 1, rootDir }))
    } else if (dirEntry.isFile() && opts.scriptPattern.test(dirEntry.name)) {
      accumulateFile({ files, file, opts, rootDir })
    }
  }

  await Promise.all(subdirPromises)
}

function accumulateFile(ctx: {
  files: string[]
  file: string
  opts: ResolvedDefaultFinderOptions
  rootDir: string
}): void {
  const { files, file, opts, rootDir } = ctx

  const filePath = '/' + relative(rootDir, file)
    .replace(/\\/gu, '/')
  if (opts.matchFilter && !filterPath(filePath, opts.matchFilter)) {
    return
  }

  if (opts.ignoreFilter && filterPath(filePath, opts.ignoreFilter)) {
    return
  }

  files.push(file)
}

function handleTypeScriptSupport(file: string): void {
  if (TYPESCRIPT_PATTERN.test(file) && !Runtime.supportTypeScript) {
    throw new ErrCannotLoadTypeScriptModule(file)
  }
}

function filterPath(path: string, filter: PathFilter): boolean {
  if (Array.isArray(filter)) {
    return filter.some(f => filterPath(path, f))
  }

  if (typeof filter === 'string') {
    return path.includes(filter)
  }

  if (filter instanceof RegExp) {
    return filter.test(path)
  }

  return filter(path)
}

function determineModuleType(fname: string, defaultType: string | undefined): 'module' | 'commonjs' {
  if (MODULE_PATTERN.test(fname)) {
    return 'module'
  }

  if (COMMONJS_PATTERN.test(fname)) {
    return 'commonjs'
  }

  return defaultType === 'module' ? 'module' : 'commonjs'
}

async function loadModules(entries: ModuleEntry[], esm: boolean): Promise<string[]> {
  return Promise.all(
    entries.map(async ({ file, type }) => {
      const url = pathToFileURL(file).href
      const importedAsModule = esm || type === 'module'

      if (importedAsModule) {
        await import(url)
      } else {
        createRequire(file)(file)
      }

      return file
    }),
  )
}

async function getPackageType(cwd: string): Promise<string | undefined> {
  if (packageTypeCache.has(cwd)) {
    return packageTypeCache.get(cwd)
  }

  const directories = cwd.split(sep)

  directories[0] = directories[0] !== '' ? directories[0] : sep

  let result: string | undefined

  while (directories.length > 0) {
    const filePath = join(...directories, 'package.json')
    const fileContents = await readFile(filePath, 'utf-8')
      .catch(() => null)

    if (fileContents) {
      result = JSON.parse(fileContents).type
      break
    }

    directories.pop()
  }

  packageTypeCache.set(cwd, result)

  return result
}
