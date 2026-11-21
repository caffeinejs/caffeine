import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { KiB } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'
import type { BuildFailure } from 'esbuild'

import type { TemplatePartials } from '../../compiled.js'
import { ErrTemplateConfiguration, ErrTemplateLimit, ErrTemplateRender } from '../../errors.js'
import { fileTemplates } from '../../file/node/node.js'
import {
  assertTemplateAlias,
  assertTemplateExtensions,
  assertTemplateName,
  templateLocale,
  type TemplateKind,
} from '../../source.js'

export interface TemplateCompiler {
  readonly extensions: Readonly<Record<'html' | 'text', string>>
  readonly moduleURL: string
  compile(
    asset: Readonly<{
      name: string
      kind: TemplateKind
      locale?: string
      source: string
    }>,
  ): string | Promise<string>
}

export interface TemplateBuildAsset {
  readonly name: string
  readonly kind: TemplateKind
  readonly locales?: readonly string[]
}

export interface BuildTemplatesOptions {
  readonly engine: 'handlebars' | 'ejs' | TemplateCompiler
  readonly roots: string | readonly string[]
  readonly assets: readonly TemplateBuildAsset[]
  readonly partials?: TemplatePartials
  readonly outFile: string
}

interface Variant {
  readonly name: string
  readonly kind: TemplateKind
  readonly locale?: string
  readonly key: string
  readonly file: string
}

const runFile = promisify(execFile)
const maxAssetSize = 256 * KiB
const maxBundleSize = 512 * KiB

async function selectCompiler(engine: BuildTemplatesOptions['engine']): Promise<TemplateCompiler> {
  if (engine === 'handlebars' || engine === 'ejs') {
    try {
      if (engine === 'handlebars') {
        const { handlebarsCompiler } = await import('../../handlebars/node/node.js')
        return handlebarsCompiler
      }
      const { ejsCompiler } = await import('../../ejs/node/node.js')
      return ejsCompiler
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        error.message.startsWith(`Cannot find package '${engine}' imported from `)
      ) {
        throw new ErrTemplateConfiguration(
          `Cannot build templates with "${engine}": install the optional "${engine}" package`,
        )
      }
      throw new ErrTemplateRender('build', engine)
    }
  }
  if (typeof engine !== 'object' || engine === null || typeof engine.compile !== 'function') {
    throw new ErrTemplateConfiguration(
      'Cannot build templates: engine must be "handlebars", "ejs" or a TemplateCompiler',
    )
  }
  return engine
}

function compilerDirectory(compiler: TemplateCompiler): string {
  assertTemplateExtensions(compiler.extensions)
  try {
    const url = new URL(compiler.moduleURL)
    if (url.protocol !== 'file:' || url.search || url.hash) {
      throw new ErrTemplateConfiguration('Cannot build templates: moduleURL must be an absolute file URL')
    }
    return dirname(fileURLToPath(url))
  } catch {
    throw new ErrTemplateConfiguration('Cannot build templates: moduleURL must be an absolute file URL')
  }
}

function declaredVariants(
  assets: readonly TemplateBuildAsset[],
  extensions: TemplateCompiler['extensions'],
): Variant[] {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new ErrTemplateConfiguration('Cannot build templates: assets must declare at least one template')
  }
  const variants = new Map<string, Variant>()
  for (const asset of assets as readonly TemplateBuildAsset[]) {
    if (typeof asset !== 'object' || asset === null || !['html', 'text'].includes(asset.kind)) {
      throw new ErrTemplateConfiguration('Cannot build templates: every asset must declare an HTML or text kind')
    }
    assertTemplateName(asset.name)
    if (['.html', '.txt', extensions.html, extensions.text].some(suffix => asset.name.endsWith(suffix))) {
      throw new ErrTemplateConfiguration('Cannot build templates: asset names must omit recognized extensions')
    }
    if (asset.locales !== undefined && !Array.isArray(asset.locales)) {
      throw new ErrTemplateConfiguration('Cannot build templates: asset locales must be an array')
    }
    const locales: (string | undefined)[] = [undefined]
    for (const locale of asset.locales ?? []) {
      locales.push(templateLocale(locale))
    }
    for (const locale of locales) {
      const stem = `${asset.name}${locale === undefined ? '' : `.${locale}`}`
      const key = `${stem}${asset.kind === 'html' ? '.html' : '.txt'}`
      if (variants.has(key)) {
        throw new ErrTemplateConfiguration(`Cannot build templates: duplicate variant "${key}"`)
      }
      variants.set(key, {
        name: asset.name,
        kind: asset.kind,
        ...(locale === undefined ? {} : { locale }),
        key,
        file: `${stem}${extensions[asset.kind]}`,
      })
    }
  }
  return [...variants.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

function declaredPartials(partials: TemplatePartials | undefined, variants: readonly Variant[]): TemplatePartials {
  if (partials === undefined) {
    return {}
  }
  if (
    typeof partials !== 'object' ||
    partials === null ||
    Object.keys(partials).some(kind => !['html', 'text'].includes(kind))
  ) {
    throw new ErrTemplateConfiguration('Cannot build templates: partials must contain only HTML and text alias maps')
  }
  const result: TemplatePartials = {}
  let count = 0
  for (const kind of ['html', 'text'] as const) {
    const aliases = partials[kind]
    if (aliases === undefined) {
      continue
    }
    if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
      throw new ErrTemplateConfiguration('Cannot build templates: partial aliases must be a dictionary')
    }
    const normalized: Record<string, string> = Object.create(null)
    for (const alias of Object.keys(aliases).sort()) {
      assertTemplateAlias(alias)
      const name = aliases[alias]
      assertTemplateName(name)
      if (!variants.some(variant => variant.name === name && variant.kind === kind && variant.locale === undefined)) {
        throw new ErrTemplateConfiguration(
          `Cannot build templates: partial "${alias}" must reference a declared asset of the same kind`,
        )
      }
      normalized[alias] = name
      count++
    }
    result[kind] = normalized
  }
  if (count > 64) {
    throw new ErrTemplateLimit('Cannot build templates: partial aliases exceed the limit of 64')
  }
  return result
}

function declarations(variants: readonly Variant[], partials: TemplatePartials): string {
  const entries = variants.map(variant => `  readonly ${JSON.stringify(variant.key)}: TemplateProgram`).join('\n')
  const maps = (['html', 'text'] as const)
    .filter(kind => partials[kind] !== undefined)
    .map(kind => {
      const aliases = Object.entries(partials[kind]!)
        .map(([alias, name]) => `    readonly ${JSON.stringify(alias)}: ${JSON.stringify(name)}`)
        .join('\n')
      return `  readonly ${kind}: {\n${aliases}\n  }`
    })
    .join('\n')
  return `import type { TemplateProgram } from '@caffeinejs/templating'\n\nexport declare const entries: {\n${entries}\n}\n\nexport declare const partials: {\n${maps}\n}\n`
}

async function bundleModules(
  modules: ReadonlyMap<string, string>,
  partials: TemplatePartials,
  resolveDir: string,
): Promise<string> {
  const { build } = await import('esbuild')
  const { init, parse } = await import('es-module-lexer')
  await init
  for (const [key, module] of modules) {
    try {
      if (parse(module)[0].some(record => record.d >= 0 && record.n === undefined)) {
        throw new ErrTemplateRender(key)
      }
    } catch {
      throw new ErrTemplateRender(key)
    }
  }
  const imports = [...modules.keys()]
    .map((key, index) => `import program${index} from ${JSON.stringify(`template:${key}`)}`)
    .join('\n')
  const entries = [...modules.keys()].map((key, index) => `${JSON.stringify(key)}: program${index}`).join(',\n')
  const result = await build({
    absWorkingDir: resolveDir,
    entryPoints: ['template-manifest'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2023',
    write: false,
    legalComments: 'eof',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
    plugins: [
      {
        name: 'template-programs',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args => {
            if (args.kind === 'entry-point') {
              return { path: 'manifest', namespace: 'template-manifest' }
            }
            if (args.path.startsWith('template:')) {
              return { path: args.path.slice('template:'.length), namespace: 'template-program' }
            }
            if (isBuiltin(args.path)) {
              return { errors: [{ text: 'Host imports are not supported in compiled templates' }] }
            }
            return undefined
          })
          build.onLoad({ filter: /.*/, namespace: 'template-manifest' }, () => ({
            contents: `${imports}\nexport const entries = {\n${entries}\n}\nexport const partials = ${JSON.stringify(partials)}\n`,
            loader: 'js',
            resolveDir,
          }))
          build.onLoad({ filter: /.*/, namespace: 'template-program' }, args => ({
            contents: modules.get(args.path),
            loader: 'js',
            resolveDir,
          }))
        },
      },
    ],
  }).catch((error: unknown) => {
    const errors = (error as Partial<BuildFailure> | null)?.errors ?? []
    const key = [...modules.keys()].find(key =>
      errors.some(
        message =>
          message.location?.file === `template-program:${key}` || message.text.includes(`"template-program:${key}"`),
      ),
    )
    throw new ErrTemplateRender(key ?? 'build')
  })
  const output = result.outputFiles[0]?.text
  if (output === undefined || parse(output)[0].some(record => record.d !== -2)) {
    throw new ErrTemplateRender('build')
  }
  return output
}

async function publish(outFile: string, output: string, types: string, keys: readonly string[]): Promise<void> {
  const directory = dirname(resolve(outFile))
  await mkdir(directory, { recursive: true })
  const temporary = await mkdtemp(join(directory, '.templates-'))
  const staged = join(temporary, 'templates.mjs')
  const stagedTypes = join(temporary, 'templates.d.ts')
  const stagedKeys = join(temporary, 'keys.json')
  const stagedFailure = join(temporary, 'failure.json')
  const lock = `${resolve(outFile)}.lock`
  let locked = false
  try {
    await writeFile(staged, output, { mode: 0o600 })
    await writeFile(stagedTypes, types, { mode: 0o600 })
    await writeFile(stagedKeys, JSON.stringify(keys), { mode: 0o600 })
    try {
      await runFile(
        process.execPath,
        [
          '--disallow-code-generation-from-strings',
          '--input-type=module',
          '--eval',
          `import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const [moduleFile, keysFile, failureFile] = process.argv.slice(1)
const keys = JSON.parse(await readFile(keysFile, 'utf8'))
const { entries } = await import(pathToFileURL(moduleFile).href)
const invalid = keys.find(key => typeof entries?.[key] !== 'function')
if (invalid !== undefined) {
  await writeFile(failureFile, JSON.stringify(invalid))
  process.exit(1)
}
if (Object.keys(entries).length !== keys.length) process.exit(1)`,
          staged,
          stagedKeys,
          stagedFailure,
        ],
        { timeout: 5 * Second, maxBuffer: 64 * KiB },
      )
    } catch {
      let invalid: unknown
      try {
        invalid = JSON.parse(await readFile(stagedFailure, 'utf8'))
      } catch {
        // Module initialization can fail before checking an individual entry.
      }
      throw new ErrTemplateRender(typeof invalid === 'string' && keys.includes(invalid) ? invalid : 'build')
    }
    await mkdir(lock, { mode: 0o700 })
    locked = true
    const extension = extname(outFile)
    const declarationFile = outFile.slice(0, -extension.length) + (extension === '.mjs' ? '.d.mts' : '.d.ts')
    const previousDeclarations = join(temporary, 'previous.d.ts')
    let hasPreviousDeclarations = false
    try {
      await copyFile(declarationFile, previousDeclarations)
      hasPreviousDeclarations = true
    } catch (error) {
      if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }
    await rename(stagedTypes, declarationFile)
    try {
      await rename(staged, outFile)
    } catch (error) {
      if (hasPreviousDeclarations) {
        await rename(previousDeclarations, declarationFile)
      } else {
        await rm(declarationFile)
      }
      throw error
    }
  } finally {
    try {
      if (locked) {
        await rmdir(lock)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}

export async function buildTemplates(options: BuildTemplatesOptions): Promise<void> {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.outFile !== 'string' ||
    !['.js', '.mjs'].includes(extname(options.outFile))
  ) {
    throw new ErrTemplateConfiguration('Cannot build templates: outFile must name an ESM .js or .mjs file')
  }
  const compiler = await selectCompiler(options.engine)
  const resolveDir = compilerDirectory(compiler)
  const variants = declaredVariants(options.assets, compiler.extensions)
  const partials = declaredPartials(options.partials, variants)
  const source = fileTemplates(options.roots)
  const modules = new Map<string, string>()
  const signal = new AbortController().signal
  let size = 0
  for (const variant of variants) {
    const text = await source.load(variant.file, maxAssetSize, signal)
    if (text === undefined) {
      throw new ErrTemplateConfiguration(`Cannot build templates: declared variant "${variant.key}" is missing`)
    }
    size += new TextEncoder().encode(text).byteLength
    if (size > maxBundleSize) {
      throw new ErrTemplateLimit('Cannot build templates: source bundle exceeds the limit of 512 KiB')
    }
    try {
      const module = await compiler.compile({
        name: variant.name,
        kind: variant.kind,
        ...(variant.locale === undefined ? {} : { locale: variant.locale }),
        source: text,
      })
      if (typeof module !== 'string') {
        throw new ErrTemplateRender(variant.key)
      }
      modules.set(variant.key, module)
    } catch {
      throw new ErrTemplateRender(variant.key)
    }
  }
  try {
    const output = await bundleModules(modules, partials, resolveDir)
    await publish(
      options.outFile,
      output,
      declarations(variants, partials),
      variants.map(variant => variant.key),
    )
  } catch (error) {
    if (error instanceof ErrTemplateRender) {
      throw error
    }
    throw new ErrTemplateRender('build')
  }
}
