import { join, relative, resolve } from 'node:path'

import type { ModuleGraphConfig } from '../../config.js'
import {
  renderFolderModule,
  renderRootModule,
  resolveSpecifier,
  toImportPath,
  writeIfChanged,
  type NamedImport,
} from './_module_graph_emit.js'
import { parseDecoratedClasses, parseExportedConsts, parseRelativeImports } from './_module_graph_parse.js'
import {
  bucketFiles,
  DEFAULT_DEPTH,
  DEFAULT_GRAPH_ROOT,
  DEFAULT_MAX_DEPTH,
  dirOf,
  GENERATED_MOD_SUFFIX,
  isHandwrittenMod,
  moduleDir,
  toRootRel,
} from './_module_graph_partition.js'
import { buildAliasResolver } from './_tsconfig_resolve.js'

export interface GenerateModuleGraphOptions {
  cwd: string
  config: ModuleGraphConfig
}

export async function generateModuleGraph(
  opts: GenerateModuleGraphOptions,
): Promise<{ changed: boolean; modules: number }> {
  const root = opts.config.root ?? DEFAULT_GRAPH_ROOT
  const importExtension = opts.config.importExtension ?? '.js'
  const depth = opts.config.depth ?? DEFAULT_DEPTH
  const depths = opts.config.depths ?? {}
  const maxDepth = opts.config.maxDepth ?? DEFAULT_MAX_DEPTH
  const skip = opts.config.skip ?? []
  const exclude = [...(opts.config.exclude ?? []), `**/*${GENERATED_MOD_SUFFIX}`]
  const moduleName = opts.config.moduleName ?? (name => name)

  const tsconfigPath = resolve(opts.cwd, opts.config.tsconfig ?? 'tsconfig.json')
  const aliasResolver = await buildAliasResolver(tsconfigPath)
  const isLocal = (spec: string): boolean => spec.startsWith('.') || aliasResolver?.resolve(spec) !== undefined

  const cwdRels = await globFiles(opts.cwd, opts.config.include, exclude)
  const rootRels: string[] = []
  const cwdByRootRel = new Map<string, string>()
  for (const cwdRel of cwdRels) {
    const rel = toRootRel(cwdRel, root)
    if (rel === undefined) {
      continue
    }
    rootRels.push(rel)
    cwdByRootRel.set(rel, cwdRel)
  }

  const partition = { depth, depths, maxDepth, skip }
  const buckets = bucketFiles(rootRels, partition)

  const bucketed = new Set<string>()
  for (const files of buckets.values()) {
    for (const rel of files) {
      bucketed.add(rel)
    }
  }

  type FileInfo = {
    abs: string
    text: string
    decorated: string[]
    handwritten: boolean
    exports: string[]
    imports: string[]
  }
  const fileInfo = new Map<string, FileInfo>()
  await Promise.all(
    rootRels.map(async rel => {
      if (!bucketed.has(rel)) {
        return
      }
      const cwdRel = cwdByRootRel.get(rel)
      if (!cwdRel) {
        return
      }
      const abs = join(opts.cwd, cwdRel)
      const text = await Bun.file(abs).text()
      const handwritten = isHandwrittenMod(rel)
      const classes = handwritten ? { exported: [], unexported: [] } : parseDecoratedClasses(text)
      for (const name of classes.unexported) {
        console.warn(`[caffeine] skipped decorated class "${name}" in "${cwdRel}": it is not exported`)
      }
      fileInfo.set(rel, {
        abs,
        text,
        decorated: classes.exported,
        handwritten,
        exports: handwritten ? parseExportedConsts(text) : [],
        imports: parseRelativeImports(text, isLocal),
      })
    }),
  )

  type Bucket = {
    dir: string
    exportName: string
    moduleName: string
    fileDir: string
    outPath: string
    decorated: Array<{ rel: string; names: string[] }>
    handwritten: Array<{ rel: string; exports: string[] }>
    needDirs: Set<string>
  }

  const used = new Map<string, Bucket>()
  for (const [dir, files] of buckets) {
    const decorated: Array<{ rel: string; names: string[] }> = []
    const handwritten: Array<{ rel: string; exports: string[] }> = []
    for (const rel of files) {
      const info = fileInfo.get(rel)
      if (!info) {
        continue
      }
      if (info.handwritten) {
        handwritten.push({ rel, exports: info.exports })
      } else if (info.decorated.length > 0) {
        decorated.push({ rel, names: info.decorated })
      }
    }
    if (decorated.length === 0 && handwritten.length === 0) {
      continue
    }
    const base = folderBasename(dir)
    const exportName = toExportName(base)
    const fileDir = dir ? join(opts.cwd, root, dir) : join(opts.cwd, root)
    used.set(dir, {
      dir,
      exportName,
      moduleName: moduleName(dir ? base : 'app'),
      fileDir,
      outPath: join(fileDir, `${base}${GENERATED_MOD_SUFFIX}`),
      decorated,
      handwritten,
      needDirs: new Set(),
    })
  }

  if (used.size === 0) {
    return { changed: false, modules: 0 }
  }

  for (const [dir, bucket] of used) {
    const files = buckets.get(dir) ?? []
    for (const rel of files) {
      const info = fileInfo.get(rel)
      if (!info) {
        continue
      }
      for (const spec of info.imports) {
        const resolved = aliasResolver?.resolve(spec) ?? resolveSpecifier(info.abs, spec)
        const cwdRel = posixRel(opts.cwd, resolved)
        const rootRel = toRootRel(cwdRel, root)
        if (rootRel === undefined) {
          continue
        }
        const targetDir = moduleDir(dirOf(rootRel), partition)
        if (targetDir !== dir && used.has(targetDir)) {
          bucket.needDirs.add(targetDir)
        }
      }
    }
  }

  const rootAbs = join(opts.cwd, root)
  const writes: Array<Promise<boolean>> = []

  for (const bucket of used.values()) {
    const needs: NamedImport[] = []
    const aliases = new Set<string>([bucket.exportName])

    const hwNeeds = collectHandwrittenNeeds(bucket, rootAbs, importExtension, aliases)
    needs.push(...hwNeeds)

    const dirNeeds = [...bucket.needDirs].sort()
    for (const needDir of dirNeeds) {
      const target = used.get(needDir)
      if (!target) {
        continue
      }
      const alias = uniqueAlias(target.exportName, needDir, aliases)
      needs.push({
        exportName: target.exportName,
        alias,
        importPath: toImportPath(bucket.fileDir, target.outPath, importExtension),
      })
    }

    const provides: NamedImport[] = []
    for (const file of [...bucket.decorated].sort((a, b) => a.rel.localeCompare(b.rel))) {
      const importPath = toImportPath(bucket.fileDir, join(opts.cwd, root, file.rel), importExtension)
      for (const name of file.names) {
        provides.push({ exportName: name, alias: uniqueAlias(name, file.rel, aliases), importPath })
      }
    }

    writes.push(
      writeIfChanged(
        bucket.outPath,
        renderFolderModule({
          exportName: bucket.exportName,
          moduleName: bucket.moduleName,
          needs,
          provides,
        }),
      ),
    )
  }

  const rootDir = rootAbs
  const rootModules: NamedImport[] = []
  const rootAliases = new Set<string>()
  const sortedBuckets = [...used.values()].sort((a, b) => a.dir.localeCompare(b.dir))
  for (const bucket of sortedBuckets) {
    const alias = uniqueAlias(bucket.exportName, bucket.dir, rootAliases)
    rootModules.push({
      exportName: bucket.exportName,
      alias,
      importPath: toImportPath(rootDir, bucket.outPath, importExtension),
    })
  }

  writes.push(writeIfChanged(join(rootDir, `root${GENERATED_MOD_SUFFIX}`), renderRootModule({ modules: rootModules })))

  const results = await Promise.all(writes)
  return { changed: results.some(Boolean), modules: used.size }
}

async function globFiles(cwd: string, include: string[], exclude: string[]): Promise<string[]> {
  const excludeGlobs = exclude.map(p => new Bun.Glob(p))
  const seen = new Set<string>()
  for (const pattern of include) {
    const glob = new Bun.Glob(pattern)
    for await (const rel of glob.scan({ cwd, onlyFiles: true })) {
      const normalized = rel.replaceAll('\\', '/')
      if (!excludeGlobs.some(g => g.match(normalized))) {
        seen.add(normalized)
      }
    }
  }
  return [...seen].sort()
}

function collectHandwrittenNeeds(
  bucket: { fileDir: string; handwritten: Array<{ rel: string; exports: string[] }> },
  rootAbs: string,
  importExtension: '.js' | '.ts' | '',
  aliases: Set<string>,
): NamedImport[] {
  const needs: NamedImport[] = []
  for (const hw of bucket.handwritten) {
    const targetAbs = join(rootAbs, hw.rel)
    for (const name of hw.exports) {
      const alias = uniqueAlias(name, hw.rel, aliases)
      needs.push({
        exportName: name,
        alias,
        importPath: toImportPath(bucket.fileDir, targetAbs, importExtension),
      })
    }
  }
  return needs
}

function folderBasename(dir: string): string {
  if (!dir) {
    return 'app'
  }
  const slash = dir.lastIndexOf('/')
  return slash === -1 ? dir : dir.slice(slash + 1)
}

function toExportName(base: string): string {
  return toIdent(base) + 'Module'
}

function toIdent(value: string): string {
  const camel = value.replace(/[^A-Za-z0-9]+(.)/gu, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z0-9]/gu, '')
  if (!camel) {
    return 'm'
  }
  if (!/^[A-Za-z_]/u.test(camel)) {
    return '_' + camel
  }
  return camel[0].toLowerCase() + camel.slice(1)
}

function uniqueAlias(exportName: string, pathKey: string, used: Set<string>): string {
  if (!used.has(exportName)) {
    used.add(exportName)
    return exportName
  }
  let alias = toIdent(pathKey.replaceAll('/', '-')) + (exportName.endsWith('Module') ? 'Module' : '')
  if (alias === exportName || used.has(alias) || !alias) {
    let i = 2
    alias = exportName + i
    while (used.has(alias)) {
      i++
      alias = exportName + i
    }
  }
  used.add(alias)
  return alias
}

function posixRel(from: string, to: string): string {
  return relative(from, to).replaceAll('\\', '/')
}
