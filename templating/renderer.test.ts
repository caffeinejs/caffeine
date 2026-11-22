import { Byte } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import {
  compiledTemplates,
  ErrTemplateCapacity,
  ErrTemplateConfiguration,
  ErrTemplateLimit,
  ErrTemplateNotFound,
  ErrTemplateRender,
  html as markup,
  memoryTemplates,
  TemplateRenderer,
  type TemplateEngine,
  type TemplateProgram,
  type TemplateSource,
} from './index.js'

const engine: TemplateEngine = {
  extensions: { html: '.raw', text: '.txt.raw' },
  compile({ source }) {
    return model => source.replace('{name}', String(model.name))
  },
}

describe('TemplateRenderer', () => {
  it('resolves kind, regional locale and groups without reading inherited keys', async () => {
    const entries = {
      'page.html': () => 'base',
      'page.pt.html': () => 'language',
      'page.pt-BR.html': () => 'region',
      'page.txt': () => 'text',
      'page.pt-BR.txt': () => 'regional text',
      'own.html': (model: Record<string, unknown>) => String(model.hidden),
    }
    const group = compiledTemplates(entries)
    const renderer = new TemplateRenderer({ default: group, named: { mail: group } })
    entries['page.html'] = () => 'mutated'

    expect(await renderer.render('page', {}, { locale: 'pt-br-u-nu-latn' })).toBe('region')
    expect(await renderer.render('page.html', {}, { locale: 'pt-PT' })).toBe('language')
    expect(await renderer.render('page', {}, { locale: 'en' })).toBe('base')
    expect(await renderer.render('page.txt', {}, { kind: 'text', locale: 'pt-BR', renderer: 'mail' })).toBe(
      'regional text',
    )
    expect(await renderer.render('own', Object.create({ hidden: 'private' }))).toBe('undefined')
    await expect(renderer.render('absent')).rejects.toBeInstanceOf(ErrTemplateNotFound)
    await expect(renderer.render('page', {}, { renderer: 'absent' })).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it('uses the same kind and locale for the page, layout, and scoped partials', async () => {
    const renderer = new TemplateRenderer({
      default: {
        ...compiledTemplates({
          'index.html': (model, context) =>
            markup`<strong>${context.partial('heading', { local: model.name })}</strong>`,
          'heading.pt.html': model => `Olá ${String(model.local)} ${String(model.name)}`,
          'heading.html': () => 'Hello',
          'index.txt': (_model, context) => context.partial('heading'),
          'heading.txt': () => 'text',
          'layout.pt-BR.html': model => `<main>${model.body}</main>`,
          'layout.html': model => `<div>${model.body}</div>`,
          'layout.txt': model => `[${model.body}]`,
        }),
        layout: 'layout',
        defaultModel: { name: 'Default', body: '<untrusted>' },
        partials: { html: { heading: 'heading' }, text: { heading: 'heading' } },
      },
    })
    expect(await renderer.render('index', { name: '<Ana>' }, { locale: 'pt-BR' })).toBe(
      '<main><strong>Olá &lt;Ana&gt; undefined</strong></main>',
    )
    expect(await renderer.render('index', {}, { layout: false })).toBe('<strong>Hello</strong>')
    expect(await renderer.render('index', {}, { kind: 'text' })).toBe('text')
    expect(await renderer.render('index', {}, { kind: 'text', layout: 'layout' })).toBe('[text]')
  })

  it.each(['../page', '/page', 'C:/page', 'a/%2e', 'a//b', 'a\\b', 'page.txt.raw'])(
    'rejects the invalid or wrong-kind name %s before reading an asset',
    async name => {
      let reads = 0
      const renderer = new TemplateRenderer({
        default: {
          engine,
          source: {
            async load() {
              reads++
              return 'found'
            },
          },
        },
      })
      await expect(renderer.render(name)).rejects.toBeInstanceOf(ErrTemplateConfiguration)
      expect(reads).toBe(0)
    },
  )

  it('rejects unsafe own model keys and stops recursive partials', async () => {
    const renderer = new TemplateRenderer({
      default: {
        ...compiledTemplates({ 'x.html': (_model, context) => context.partial('self') }),
        partials: { html: { self: 'x' } },
      },
    })
    await expect(renderer.render('x', { constructor: 'ignored' })).rejects.toBeInstanceOf(ErrTemplateConfiguration)
    await expect(renderer.render('x')).rejects.toBeInstanceOf(ErrTemplateLimit)
  })

  it('fails explicitly for missing aliases and rejects UTF-8 output beyond the byte limit', async () => {
    const renderer = new TemplateRenderer({
      default: {
        ...compiledTemplates({
          'include.html': (_model, context) => context.partial('absent'),
          'utf8.html': () => 'éé',
        }),
        limits: { maxOutputSize: 3 * Byte },
      },
    })
    await expect(renderer.render('include')).rejects.toThrow('partial "absent" is not declared')
    await expect(renderer.render('utf8')).rejects.toBeInstanceOf(ErrTemplateLimit)
  })

  it('requires a nonempty explicit layout name', async () => {
    const renderer = new TemplateRenderer({
      default: { ...compiledTemplates({ 'page.html': () => 'page' }), layout: false },
    })
    await expect(renderer.render('page', {}, { layout: '' })).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  })

  it('rejects a thenable program and consumes its rejection', async () => {
    let observed = false
    const invalid = (() => ({
      then(_resolve: unknown, reject: (cause: Error) => void) {
        observed = true
        reject(new Error('unavailable'))
      },
    })) as unknown as TemplateProgram
    const renderer = new TemplateRenderer({ default: compiledTemplates({ 'page.html': invalid }) })
    await expect(renderer.render('page')).rejects.toBeInstanceOf(ErrTemplateRender)
    expect(observed).toBe(true)
  })

  it('shares pending cache-off reads and reloads after settlement', async () => {
    const initial = Promise.withResolvers<string>()
    let reads = 0
    const source: TemplateSource = {
      async load() {
        return ++reads === 1 ? initial.promise : 'next'
      },
    }
    const renderer = new TemplateRenderer({ default: { source, engine, cache: false } })
    const first = renderer.render('item')
    const second = renderer.render('item')
    initial.resolve('first')
    expect(await Promise.all([first, second])).toEqual(['first', 'first'])
    expect(await renderer.render('item')).toBe('next')
    expect(reads).toBe(2)
  })

  it('snapshots the memory source and lets explicit extensions override the engine', async () => {
    const entries = { 'item.pt.custom': 'Olá {name}', 'item.custom': 'Hi {name}' }
    const source = memoryTemplates(entries)
    entries['item.pt.custom'] = 'mutated'
    const renderer = new TemplateRenderer({ default: { source, engine, extensions: { html: '.custom' } } })
    expect(await renderer.render('item', { name: 'Ana' }, { locale: 'pt-BR' })).toBe('Olá Ana')
  })

  it('distinguishes an absent asset from a failed read and retries a failed cold build', async () => {
    const requested: string[] = []
    let error = true
    const source: TemplateSource = {
      async load(name) {
        requested.push(name)
        if (name === 'item.pt-BR.raw' && error) {
          throw new Error('private directory')
        }
        return name === 'item.raw' ? 'Hi {name}' : undefined
      },
    }
    const renderer = new TemplateRenderer({ default: { source, engine } })
    await expect(renderer.render('item', { name: 'Ana' }, { locale: 'pt-BR' })).rejects.toMatchObject({
      code: 'ERR_TEMPLATE_RENDER',
      message: expect.not.stringContaining('private directory'),
    })
    expect(requested).toEqual(['item.pt-BR.raw'])
    error = false
    expect(await renderer.render('item', { name: 'Ana' }, { locale: 'pt-BR' })).toBe('Hi Ana')
    expect(requested).toEqual(['item.pt-BR.raw', 'item.pt-BR.raw', 'item.pt.raw', 'item.raw'])
  })

  it('warms once per key, evicts the least recently used bundle, and can reload every call', async () => {
    let revision = 0
    const source: TemplateSource = {
      async load() {
        return String(++revision)
      },
    }
    const cached = new TemplateRenderer({ default: { source, engine, cache: { maxEntries: 2 } } })
    expect(await cached.render('first')).toBe('1')
    expect(await cached.render('second')).toBe('2')
    expect(await cached.render('first')).toBe('1')
    expect(await cached.render('third')).toBe('3')
    expect(await cached.render('second')).toBe('4')
    const live = new TemplateRenderer({ default: { source, engine, cache: false } })
    expect(await live.render('first')).toBe('5')
    expect(await live.render('first')).toBe('6')
  })

  it('lets one aborted caller leave a shared cold build without canceling a second caller', async () => {
    const opened = Promise.withResolvers<AbortSignal>()
    const contents = Promise.withResolvers<string>()
    let reads = 0
    const source: TemplateSource = {
      async load(_name, _maxSize, signal) {
        reads++
        opened.resolve(signal)
        return contents.promise
      },
    }
    const renderer = new TemplateRenderer({ default: { source, engine } })
    const abort = new AbortController()
    const first = renderer.render('page', {}, { signal: abort.signal })
    const sharedSignal = await opened.promise
    const second = renderer.render('page')
    const reason = new Error('client canceled')
    abort.abort(reason)
    await expect(first).rejects.toBe(reason)
    expect(sharedSignal.aborted).toBe(false)
    contents.resolve('ready')
    expect(await second).toBe('ready')
    expect(await renderer.render('page')).toBe('ready')
    expect(reads).toBe(1)
  })

  it('caps concurrent cache-off builds and retains admission until cancelled work settles', async () => {
    const work = Promise.withResolvers<string>()
    const source: TemplateSource = {
      async load() {
        return work.promise
      },
    }
    const renderer = new TemplateRenderer({ default: { source, engine, cache: false } })
    const abort = new AbortController()
    const running = Array.from({ length: 8 }, (_, id) => renderer.render(`item-${id}`, {}, { signal: abort.signal }))
    await expect(renderer.render('overflow')).rejects.toBeInstanceOf(ErrTemplateCapacity)
    const settled = Promise.allSettled(running)
    abort.abort()
    expect((await settled).map(result => result.status)).toEqual(Array(8).fill('rejected'))
    await expect(renderer.render('still-full')).rejects.toBeInstanceOf(ErrTemplateCapacity)
    work.resolve('later')
  })
})
