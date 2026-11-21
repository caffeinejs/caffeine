import { KiB, type ByteSize } from '@caffeinejs/std/bytes'
import { Second } from '@caffeinejs/std/duration'

import {
  compiledTemplates,
  type CompiledTemplateOptions,
  type TemplateEntries,
  type TemplateModel,
  type TemplatePartials,
  type TemplateProgram,
} from './compiled.js'
import {
  ErrTemplateCapacity,
  ErrTemplateConfiguration,
  ErrTemplateLimit,
  ErrTemplateNotFound,
  ErrTemplateRender,
} from './errors.js'
import { isSafeHTML } from './html/html.js'
import {
  assertTemplateAlias,
  assertTemplateExtensions,
  assertTemplateName,
  assertTemplateSize,
  COMPILED_EXTENSIONS,
  RESERVED_TEMPLATE_KEYS,
  templateLocale,
  type TemplateEngine,
  type TemplateExtensions,
  type TemplateKind,
  type TemplateSource,
} from './source.js'

export interface TemplateLimits {
  readonly maxAssetSize?: ByteSize
  readonly maxBundleSize?: ByteSize
  readonly maxPartials?: number
  readonly maxOutputSize?: ByteSize
}

export interface GroupSettings {
  readonly layout?: string | false
  readonly cache?: false | { readonly maxEntries?: number }
  readonly limits?: TemplateLimits
}

export type TemplateGroupOptions = GroupSettings & {
  readonly defaultModel?: TemplateModel
  readonly partials?: TemplatePartials
} & (
    | (CompiledTemplateOptions & { readonly source?: never; readonly engine?: never; readonly extensions?: never })
    | {
        readonly entries?: never
        readonly source: TemplateSource
        readonly engine: TemplateEngine
        readonly extensions?: Partial<TemplateExtensions>
      }
  )

export interface TemplateRendererOptions {
  readonly default?: TemplateGroupOptions
  readonly named?: Readonly<Record<string, TemplateGroupOptions>>
}

export interface TemplateRenderOptions {
  readonly renderer?: string
  readonly kind?: TemplateKind
  readonly locale?: string
  readonly layout?: string | false
  readonly signal?: AbortSignal
}

const DEFAULT_LIMITS: Required<TemplateLimits> = {
  maxAssetSize: 256 * KiB,
  maxBundleSize: 512 * KiB,
  maxPartials: 64,
  maxOutputSize: 512 * KiB,
}
const MAX_BUILDS = 8
const BUILD_TIMEOUT = 5 * Second
const NO_SIGNAL = new AbortController().signal

interface ResolvedTemplate {
  readonly name: string
  readonly program: TemplateProgram
}
interface Bundle {
  readonly page: ResolvedTemplate
  readonly layout?: ResolvedTemplate
  readonly partials: ReadonlyMap<string, ResolvedTemplate>
  readonly aliases: readonly string[]
}

export class TemplateRenderer {
  readonly #groups = new Map<string, TemplateGroup>()

  constructor(options: TemplateRendererOptions) {
    if (options.default !== undefined) {
      this.#groups.set('default', new TemplateGroup(options.default))
    }
    for (const [name, optionsForGroup] of Object.entries(options.named ?? {})) {
      assertRendererName(name)
      this.#groups.set(name, new TemplateGroup(optionsForGroup))
    }
  }

  /** Render a logical template with fresh own-key data and an optional cancellation signal. */
  async render(name: string, model?: TemplateModel, options: TemplateRenderOptions = {}): Promise<string> {
    const signal = options.signal ?? NO_SIGNAL
    signal.throwIfAborted()
    const renderer = options.renderer ?? 'default'
    const group = this.#groups.get(renderer)
    if (group === undefined) {
      throw new ErrTemplateConfiguration('Cannot render template: requested renderer group is not registered')
    }
    return group.render(name, model, options, signal)
  }
}

export function assertRendererName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || name === 'default' || RESERVED_TEMPLATE_KEYS.has(name)) {
    throw new ErrTemplateConfiguration('Cannot register named template renderer: expected a nonreserved renderer name')
  }
}

class TemplateGroup {
  readonly #source?: TemplateSource
  readonly #engine?: TemplateEngine
  readonly #entries?: TemplateEntries
  readonly #extensions: TemplateExtensions
  readonly #limits: Required<TemplateLimits>
  readonly #layout?: string | false
  readonly #defaults: TemplateModel
  readonly #partials: Record<TemplateKind, ReadonlyMap<string, string>>
  readonly #maxEntries: number
  readonly #cached = new Map<string, Bundle>()
  readonly #building = new Map<string, Promise<Bundle>>()
  #active = 0

  constructor(options: TemplateGroupOptions) {
    if (options.entries !== undefined) {
      this.#entries = compiledTemplates(options.entries).entries
      this.#extensions = COMPILED_EXTENSIONS
    } else {
      if (typeof options.source?.load !== 'function' || typeof options.engine?.compile !== 'function') {
        throw new ErrTemplateConfiguration('Cannot register source templates: both source and engine are required')
      }
      this.#source = options.source
      this.#engine = options.engine
      this.#extensions = { ...options.engine.extensions, ...options.extensions }
      assertTemplateExtensions(this.#extensions)
    }

    this.#layout = options.layout
    if (options.layout !== undefined && options.layout !== false) {
      this.#name(options.layout, 'html')
    }
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#defaults = mergeModel(options.defaultModel)
    this.#maxEntries = options.cache === false ? 0 : positive(options.cache?.maxEntries ?? 128, 'maxEntries')
    for (const [key, value] of Object.entries(this.#limits)) {
      positive(value, key)
    }
    this.#partials = {
      html: this.#partialMap(options.partials?.html, 'html'),
      text: this.#partialMap(options.partials?.text, 'text'),
    }
    if (this.#partials.html.size + this.#partials.text.size > this.#limits.maxPartials) {
      throw new ErrTemplateLimit('Cannot register template partials: alias count exceeds maxPartials')
    }
  }

  async render(rawName: string, model: TemplateModel | undefined, options: TemplateRenderOptions, signal: AbortSignal) {
    const kind = options.kind ?? 'html'
    if (kind !== 'html' && kind !== 'text') {
      throw new ErrTemplateConfiguration('Cannot render template: expected HTML or text kind')
    }
    const name = this.#name(rawName, kind)
    const locale = options.locale === undefined ? undefined : templateLocale(options.locale)
    const layoutOption = options.layout ?? (kind === 'html' ? this.#layout : false)
    const layout = layoutOption === false || layoutOption === undefined ? undefined : this.#name(layoutOption, kind)
    const data = mergeModel(this.#defaults, model)
    const bundle = await this.#bundle(name, kind, locale, layout, signal)
    signal.throwIfAborted()

    const stack: string[] = []
    const context = Object.freeze({
      signal,
      partials: bundle.aliases,
      partial: (alias: string, input?: TemplateModel): string => {
        const entry = bundle.partials.get(alias)
        if (entry === undefined) {
          assertTemplateAlias(alias)
          throw new ErrTemplateRender(stack.at(-1) ?? name, undefined, alias)
        }
        return evaluate(entry, mergeModel(input))
      },
    })
    const evaluate = (entry: ResolvedTemplate, input: TemplateModel): string => {
      signal.throwIfAborted()
      if (stack.length >= 32 || stack.includes(entry.name)) {
        throw new ErrTemplateLimit('Cannot render template partial: recursive include or nesting exceeds 32 levels')
      }
      stack.push(entry.name)
      try {
        const value = entry.program(input, context)
        const result = kind === 'html' && isSafeHTML(value) ? value.toString() : value
        if (typeof result !== 'string') {
          // A faulty program may return a rejecting thenable. Preserve the synchronous contract without leaking it.
          if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
            void Promise.resolve(value).catch(() => undefined)
          }
          throw new ErrTemplateRender(entry.name)
        }
        assertTemplateSize(result, this.#limits.maxOutputSize, 'rendered template')
        signal.throwIfAborted()
        return result
      } catch (error) {
        signal.throwIfAborted()
        if (
          error instanceof ErrTemplateLimit ||
          error instanceof ErrTemplateRender ||
          error instanceof ErrTemplateConfiguration
        ) {
          throw error
        }
        throw new ErrTemplateRender(entry.name)
      } finally {
        stack.pop()
      }
    }

    const body = evaluate(bundle.page, data)
    return bundle.layout ? evaluate(bundle.layout, mergeModel(data, { body })) : body
  }

  #name(rawName: string, kind: TemplateKind): string {
    const suffix = [this.#extensions.html, this.#extensions.text]
      .sort((a, b) => b.length - a.length)
      .find(extension => typeof rawName === 'string' && rawName.endsWith(extension))
    if (suffix !== undefined && suffix !== this.#extensions[kind]) {
      throw new ErrTemplateConfiguration('Cannot use template name: file suffix does not match the requested kind')
    }
    const name = suffix === undefined ? rawName : rawName.slice(0, -suffix.length)
    assertTemplateName(name)
    return name
  }

  #partialMap(values: Readonly<Record<string, string>> | undefined, kind: TemplateKind) {
    const partials = new Map<string, string>()
    for (const [alias, name] of Object.entries(values ?? {})) {
      assertTemplateAlias(alias)
      partials.set(alias, this.#name(name, kind))
    }
    return partials
  }

  #bundle(
    name: string,
    kind: TemplateKind,
    locale: string | undefined,
    layout: string | undefined,
    signal: AbortSignal,
  ) {
    const key = JSON.stringify([kind, name, locale, layout])
    const hit = this.#cached.get(key)
    if (hit !== undefined) {
      this.#cached.delete(key)
      this.#cached.set(key, hit)
      return hit
    }
    let work = this.#building.get(key)
    if (work !== undefined) {
      return waitFor(work, signal)
    }
    if (this.#active >= MAX_BUILDS) {
      throw new ErrTemplateCapacity()
    }
    this.#active++
    const deadline = AbortSignal.timeout(BUILD_TIMEOUT)
    work = this.#prepare(name, kind, locale, layout, deadline)
      .then(bundle => {
        deadline.throwIfAborted()
        if (this.#maxEntries !== 0) {
          this.#cached.set(key, bundle)
          const oldest = this.#cached.keys().next()
          if (this.#cached.size > this.#maxEntries && !oldest.done) {
            this.#cached.delete(oldest.value)
          }
        }
        return bundle
      })
      .finally(() => {
        this.#active--
        this.#building.delete(key)
      })

    const bounded = waitFor(work, deadline)
    this.#building.set(key, bounded)
    return waitFor(bounded, signal)
  }

  async #prepare(
    name: string,
    kind: TemplateKind,
    locale: string | undefined,
    layout: string | undefined,
    signal: AbortSignal,
  ) {
    const programs = new Map<string, ResolvedTemplate>()
    let size = 0
    const load = async (assetName: string): Promise<ResolvedTemplate> => {
      const loaded = programs.get(assetName)
      if (loaded !== undefined) {
        return loaded
      }
      const extension = this.#extensions[kind]
      let variant = locale
      for (;;) {
        signal.throwIfAborted()
        const filename = variant ? `${assetName}.${variant}${extension}` : `${assetName}${extension}`
        try {
          let program = this.#entries?.[filename]
          if (this.#source && this.#engine) {
            const source = await this.#source.load(filename, this.#limits.maxAssetSize, signal)
            signal.throwIfAborted()
            if (source !== undefined) {
              if (typeof source !== 'string') {
                throw new ErrTemplateRender(assetName)
              }
              size += assertTemplateSize(source, this.#limits.maxAssetSize, 'template asset')
              if (size > this.#limits.maxBundleSize) {
                throw new ErrTemplateLimit('Cannot prepare template bundle: source text exceeds maxBundleSize')
              }
              program = await this.#engine.compile({ name: assetName, kind, locale: variant, source, signal })
              signal.throwIfAborted()
              if (typeof program !== 'function') {
                throw new ErrTemplateRender(assetName)
              }
            }
          }
          if (program !== undefined) {
            const resolved = { name: assetName, program }
            programs.set(assetName, resolved)
            return resolved
          }
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof ErrTemplateLimit || error instanceof ErrTemplateRender) {
            throw error
          }
          throw new ErrTemplateRender(assetName)
        }
        if (variant === undefined) {
          throw new ErrTemplateNotFound(assetName)
        }
        const separator = variant.lastIndexOf('-')
        variant = separator === -1 ? undefined : variant.slice(0, separator)
      }
    }

    const page = await load(name)
    const layoutProgram = layout === undefined ? undefined : await load(layout)
    const partials = new Map<string, ResolvedTemplate>()
    for (const [alias, target] of this.#partials[kind]) {
      partials.set(alias, await load(target))
    }
    return { page, layout: layoutProgram, partials, aliases: Object.freeze([...partials.keys()]) }
  }
}

function mergeModel(...models: (TemplateModel | undefined)[]): Record<string, unknown> {
  const data = Object.create(null) as Record<string, unknown>
  for (const model of models) {
    for (const [key, value] of Object.entries(model ?? {})) {
      if (RESERVED_TEMPLATE_KEYS.has(key)) {
        throw new ErrTemplateConfiguration('Cannot use template model: model contains a reserved key')
      }
      data[key] = value
    }
  }
  return data
}

function positive(value: number, option: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ErrTemplateConfiguration(`Cannot configure template limit "${option}": expected a positive integer`)
  }
  return value
}

function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal === NO_SIGNAL) {
    return work
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
    }
    void work.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}
