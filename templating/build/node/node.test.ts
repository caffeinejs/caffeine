import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { KiB } from '@caffeinejs/std/bytes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compiledTemplates, type TemplateEntries, type TemplatePartials } from '../../compiled.js'
import { ejsTemplates } from '../../ejs/node/index.js'
import { ErrTemplateConfiguration, ErrTemplateLimit, ErrTemplateRender } from '../../errors.js'
import { fileTemplates } from '../../file/node/index.js'
import { TemplateRenderer } from '../../renderer.js'
import { buildTemplates, type TemplateCompiler } from './node.js'

describe('ahead-of-time templates', { timeout: 30_000 }, () => {
  let directory: string
  let outFile: string
  let compiler: TemplateCompiler
  let revision = 0

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'caffeine-template-build-'))
    outFile = join(directory, 'templates.mjs')
    compiler = {
      extensions: { html: '.receipt', text: '.txt.receipt' },
      moduleURL: pathToFileURL(join(directory, 'compiler.js')).href,
      compile: asset => `export default model => ${JSON.stringify(asset.source)} + String(model.name)`,
    }
    await writeFile(join(directory, 'welcome.receipt'), 'Hello, ')
    await writeFile(join(directory, 'welcome.txt.receipt'), 'Text: ')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function build(engine: TemplateCompiler = compiler) {
    return buildTemplates({
      engine,
      roots: directory,
      assets: [
        { name: 'welcome', kind: 'html' },
        { name: 'welcome', kind: 'text' },
      ],
      partials: { html: { greeting: 'welcome' }, text: { greeting: 'welcome' } },
      outFile,
    })
  }

  async function manifest(): Promise<{ entries: TemplateEntries; partials: TemplatePartials }> {
    return import(`${pathToFileURL(outFile).href}?revision=${revision++}`)
  }

  it('reports invalid include locals through the same renderer error for live and compiled EJS', async () => {
    await writeFile(join(directory, 'page.ejs'), '<%- include("piece", true) %>')
    await writeFile(join(directory, 'piece.ejs'), 'piece')
    const partials = { html: { piece: 'piece' } }
    await buildTemplates({
      engine: 'ejs',
      roots: directory,
      assets: [
        { name: 'page', kind: 'html' },
        { name: 'piece', kind: 'html' },
      ],
      partials,
      outFile,
    })
    const { entries } = await manifest()
    const runtime = new TemplateRenderer({
      default: { source: fileTemplates(directory), engine: ejsTemplates(), partials },
      named: { compiled: { ...compiledTemplates(entries), partials } },
    })
    await expect(runtime.render('page', {}, { renderer: 'compiled' })).rejects.toMatchObject({
      code: 'ERR_TEMPLATE_RENDER',
      template: 'page',
    })
    await expect(runtime.render('page')).rejects.toMatchObject({
      code: 'ERR_TEMPLATE_RENDER',
      template: 'page',
    })
  })

  it('bundles an independently authored helper and publishes both kinds and declarations', async () => {
    await writeFile(
      join(directory, 'format.js'),
      'export const format = value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;")\n',
    )
    await writeFile(join(directory, 'package.json'), '{"type":"module"}')
    await build({
      ...compiler,
      async compile(asset) {
        return `import { format } from './format.js'\nexport default model => ${JSON.stringify(asset.source)} + ${asset.kind === 'html' ? 'format(model.name)' : 'String(model.name)'}`
      },
    })
    await rm(join(directory, 'format.js'))
    const { entries, partials } = await manifest()
    const context = { signal: new AbortController().signal, partials: [], partial: () => '' }
    expect(Object.keys(entries)).toEqual(['welcome.html', 'welcome.txt'])
    expect(entries['welcome.html']({ name: '<Ada>' }, context)).toBe('Hello, &lt;Ada&gt;')
    expect(entries['welcome.html']({ name: '<Lin>' }, context)).toBe('Hello, &lt;Lin&gt;')
    expect(entries['welcome.txt']({ name: '<Ada>' }, context)).toBe('Text: <Ada>')
    expect(partials).toEqual({ html: { greeting: 'welcome' }, text: { greeting: 'welcome' } })
    expect(await readFile(join(directory, 'templates.d.mts'), 'utf8')).toBe(
      "import type { TemplateProgram } from '@caffeinejs/templating'\n\n" +
        'export declare const entries: {\n  readonly "welcome.html": TemplateProgram\n  readonly "welcome.txt": TemplateProgram\n}\n\n' +
        'export declare const partials: {\n  readonly html: {\n    readonly "greeting": "welcome"\n  }\n  readonly text: {\n    readonly "greeting": "welcome"\n  }\n}\n',
    )
    expect(await readFile(outFile, 'utf8')).not.toContain(directory)
  })

  it.each(['handlebars', 'ejs'] as const)(
    'builds %s HTML and text with scoped nested and empty partials',
    async engine => {
      const extension = engine === 'handlebars' ? 'hbs' : 'ejs'
      const value = engine === 'handlebars' ? '{{name}}' : '<%= locals.name %>'
      const include = (alias: string) => (engine === 'handlebars' ? `{{> ${alias}}}` : `<%- include('${alias}') %>`)
      for (const [name, html, text] of [
        ['welcome', `<p>${value}:${include('piece')}</p>`, `${value}:${include('piece')}`],
        ['piece', `<b>${value}</b>${include('empty')}`, `(${value})${include('empty')}`],
        ['empty', '', ''],
      ]) {
        await writeFile(join(directory, `${name}.${extension}`), html)
        await writeFile(join(directory, `${name}.txt.${extension}`), text)
      }
      await buildTemplates({
        engine,
        roots: directory,
        assets: ['welcome', 'piece', 'empty'].flatMap(name => [
          { name, kind: 'html' as const },
          { name, kind: 'text' as const },
        ]),
        partials: { html: { piece: 'piece', empty: 'empty' }, text: { piece: 'piece', empty: 'empty' } },
        outFile,
      })
      const { entries, partials } = await manifest()
      for (const [kind, expected] of [
        ['html', '<p>&lt;Ada&gt;:<b>&lt;Ada&gt;</b></p>'],
        ['text', '<Ada>:(<Ada>)'],
      ] as const) {
        const suffix = kind === 'html' ? '.html' : '.txt'
        const context = {
          signal: new AbortController().signal,
          partials: Object.keys(partials[kind]!),
          partial(alias: string, model = {}) {
            return String(entries[`${partials[kind]![alias]}${suffix}`](model, context))
          },
        }
        expect(entries[`welcome${suffix}`]({ name: '<Ada>' }, context)).toBe(expected)
      }
    },
  )

  it('compiles canonical, exact locale variants and reports stable keys', async () => {
    await writeFile(join(directory, 'welcome.pt-BR.receipt'), 'Oi, ')
    await buildTemplates({
      engine: {
        ...compiler,
        compile(asset) {
          return `export default () => (${JSON.stringify(asset)})`
        },
      },
      roots: directory,
      assets: [{ name: 'welcome', kind: 'html', locales: ['pt-br'] }],
      outFile,
    })
    const { entries } = await manifest()
    expect(Object.keys(entries)).toEqual(['welcome.html', 'welcome.pt-BR.html'])
    const context = { signal: new AbortController().signal, partials: [], partial: () => '' }
    expect(entries['welcome.pt-BR.html']({}, context)).toEqual({
      name: 'welcome',
      kind: 'html',
      locale: 'pt-BR',
      source: 'Oi, ',
    })
  })

  it.each([
    ['host builtin', 'import { readFile } from "node:fs/promises"\nexport default () => readFile("x")'],
    ['bare host builtin', 'import { readFile } from "fs/promises"\nexport default () => readFile("x")'],
    ['computed import', 'export default model => import(model.helper)'],
    ['missing default', 'export const render = () => "changed"'],
    ['noncallable default', 'export default 42'],
    ['dynamic evaluation', `export default new Function('return "changed"')`],
    ['invalid syntax', 'export default )'],
    ['evaluation error', 'throw new Error("secret source")\nexport default () => "changed"'],
  ])('preserves the prior manifest when an adapter emits a %s', async (_name, source) => {
    await build()
    const previous = await readFile(outFile, 'utf8')
    const previousTypes = await readFile(join(directory, 'templates.d.mts'), 'utf8')
    await expect(build({ ...compiler, compile: () => source })).rejects.toBeInstanceOf(ErrTemplateRender)
    expect(await readFile(outFile, 'utf8')).toBe(previous)
    expect(await readFile(join(directory, 'templates.d.mts'), 'utf8')).toBe(previousTypes)
    const { entries } = await manifest()
    expect(
      entries['welcome.html'](
        { name: 'Ada' },
        { signal: new AbortController().signal, partials: [], partial: () => '' },
      ),
    ).toBe('Hello, Ada')
  })

  it('preserves prior output when compilation rejects without exposing the source or host path', async () => {
    await build()
    const previous = await readFile(outFile, 'utf8')
    const failure = build({ ...compiler, compile: () => Promise.reject(new Error(`secret ${directory}`)) })
    await expect(failure).rejects.toMatchObject({ code: 'ERR_TEMPLATE_RENDER' })
    await expect(failure).rejects.not.toThrow(directory)
    await expect(failure).rejects.not.toThrow('secret')
    expect(await readFile(outFile, 'utf8')).toBe(previous)
  })

  it('requires a listed locale instead of falling back to the unqualified source', async () => {
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html', locales: ['pt'] }],
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it.each([{ extensions: { html: '.receipt', text: '.receipt' } }, { moduleURL: '/private/compiler.js' }])(
    'rejects invalid adapter metadata before publication',
    async metadata => {
      await expect(build({ ...compiler, ...metadata })).rejects.toBeInstanceOf(ErrTemplateConfiguration)
    },
  )

  it('rejects an unknown selector and undeclared partial targets', async () => {
    await expect(
      buildTemplates({
        // @ts-expect-error Unknown selectors are refused at the runtime boundary as well.
        engine: 'unknown',
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html' }],
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateConfiguration)
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html' }],
        partials: { text: { wrongKind: 'welcome' } },
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it('rejects canonical locale collisions before calling the compiler', async () => {
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html', locales: ['pt-br', 'pt-BR'] }],
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it('rejects a combined source bundle above 512 KiB and an alias map above 64 entries', async () => {
    for (const name of ['first', 'second', 'third']) {
      await writeFile(join(directory, `${name}.receipt`), 'x'.repeat(180 * KiB))
    }
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: ['first', 'second', 'third'].map(name => ({ name, kind: 'html' })),
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateLimit)
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html' }],
        partials: { html: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`alias${index}`, 'welcome'])) },
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateLimit)
  })

  it('produces reproducible output and emits .d.ts for a .js destination', async () => {
    outFile = join(directory, 'templates.js')
    await build()
    const first = await readFile(outFile, 'utf8')
    await build()
    expect(await readFile(outFile, 'utf8')).toBe(first)
    expect(await readFile(join(directory, 'templates.d.ts'), 'utf8')).toContain(
      'readonly "welcome.html": TemplateProgram',
    )
  })

  it('preserves the previous declarations when publishing the runtime file fails', async () => {
    await mkdir(outFile)
    const declarationFile = join(directory, 'templates.d.mts')
    await writeFile(declarationFile, 'previous declarations\n')
    await expect(build()).rejects.toBeInstanceOf(ErrTemplateRender)
    expect(await readFile(declarationFile, 'utf8')).toBe('previous declarations\n')
  })

  it.each(['__proto__', 'prototype', 'constructor'])('rejects the reserved partial alias %s', async alias => {
    await expect(
      buildTemplates({
        engine: compiler,
        roots: directory,
        assets: [{ name: 'welcome', kind: 'html' }],
        partials: { html: { [alias]: 'welcome' } },
        outFile,
      }),
    ).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it('refuses publication while another publisher owns the target lock and preserves the complete previous pair', async () => {
    await build()
    const previous = await readFile(outFile, 'utf8')
    const declarationsFile = join(directory, 'templates.d.mts')
    const previousDeclarations = await readFile(declarationsFile, 'utf8')
    const lock = `${outFile}.lock`
    await mkdir(lock)
    await expect(build({ ...compiler, compile: () => 'export default () => "changed"' })).rejects.toBeInstanceOf(
      ErrTemplateRender,
    )
    expect(await readFile(outFile, 'utf8')).toBe(previous)
    expect(await readFile(declarationsFile, 'utf8')).toBe(previousDeclarations)
    expect(await readdir(lock)).toEqual([])
    await rm(lock, { recursive: true })
    await build({ ...compiler, compile: () => 'export default () => "changed"' })
    expect(
      (await manifest()).entries['welcome.html'](
        {},
        { signal: new AbortController().signal, partials: [], partial: () => '' },
      ),
    ).toBe('changed')
    expect((await readdir(directory)).filter(name => name.endsWith('.lock') || name.startsWith('.templates-'))).toEqual(
      [],
    )
  })

  it('keeps the runtime and declaration keys together when two builds publish the same target', async () => {
    const results = await Promise.allSettled(
      (['html', 'text'] as const).map(kind =>
        buildTemplates({
          engine: { ...compiler, compile: () => `export default () => ${JSON.stringify(kind)}` },
          roots: directory,
          assets: [{ name: 'welcome', kind }],
          outFile,
        }),
      ),
    )
    expect([1, 2]).toContain(results.filter(result => result.status === 'fulfilled').length)
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ErrTemplateRender)
      }
    }
    const { entries } = await manifest()
    const declarations = await readFile(join(directory, 'templates.d.mts'), 'utf8')
    const declaredKeys = [...declarations.matchAll(/readonly "([^"]+)": TemplateProgram/g)].map(match => match[1])
    expect(declaredKeys).toEqual(Object.keys(entries))
    expect(Object.keys(entries)).toHaveLength(1)
    expect((await readdir(directory)).filter(name => name.endsWith('.lock') || name.startsWith('.templates-'))).toEqual(
      [],
    )
  })

  it('identifies the declared variant with a noncallable default without exposing build paths', async () => {
    await expect(
      build({
        ...compiler,
        compile: asset => (asset.kind === 'text' ? 'export default 42' : 'export default () => "html"'),
      }),
    ).rejects.toMatchObject({ code: 'ERR_TEMPLATE_RENDER', template: 'welcome.txt' })
  })

  it.each(['export default )', 'export const render = () => "text"', 'export default model => import(model.helper)'])(
    'identifies the declared variant with invalid module output %s',
    async source => {
      await expect(
        build({
          ...compiler,
          compile: asset => (asset.kind === 'text' ? source : 'export default () => "html"'),
        }),
      ).rejects.toMatchObject({ code: 'ERR_TEMPLATE_RENDER', template: 'welcome.txt' })
    },
  )

  it('validates a large empty manifest without placing its keys in process arguments', async () => {
    const assets = Array.from({ length: 7200 }, (_, index) => ({
      name: `page${String(index).padStart(4, '0')}${'x'.repeat(140)}`,
      kind: 'html' as const,
    }))
    for (let index = 0; index < assets.length; index += 64) {
      await Promise.all(
        assets.slice(index, index + 64).map(asset => writeFile(join(directory, `${asset.name}.receipt`), '')),
      )
    }
    await buildTemplates({
      engine: { ...compiler, compile: () => 'export default () => ""' },
      roots: directory,
      assets,
      outFile,
    })
    const { entries } = await manifest()
    expect(Object.keys(entries)).toEqual(assets.map(asset => `${asset.name}.html`))
  })

  it('keeps import.meta distinct from module imports', async () => {
    await build({ ...compiler, compile: () => 'export default () => import.meta.url' })
    expect((await readFile(outFile, 'utf8')).includes('import.meta.url')).toBe(true)
  })
})
