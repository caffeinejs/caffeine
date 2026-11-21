import { ErrTemplateConfiguration } from './errors.js'
import type { SafeHTML } from './html/html.js'
import { assertTemplateName, COMPILED_EXTENSIONS, templateLocale, type TemplateKind } from './source.js'

export type TemplateModel = Readonly<Record<string, unknown>>
export type TemplatePartials = Partial<Record<TemplateKind, Readonly<Record<string, string>>>>

export interface TemplateContext {
  readonly signal: AbortSignal
  readonly partials: readonly string[]
  partial(alias: string, model?: TemplateModel): string
}

export type TemplateProgram = (model: TemplateModel, context: TemplateContext) => string | SafeHTML
export type TemplateEntries = Readonly<Record<string, TemplateProgram>>

export interface CompiledTemplateOptions {
  readonly entries: TemplateEntries
}

export function compiledTemplates(entries: TemplateEntries): CompiledTemplateOptions {
  const snapshot = Object.create(null) as Record<string, TemplateProgram>
  for (const [name, program] of Object.entries(entries)) {
    const suffix = Object.values(COMPILED_EXTENSIONS).find(extension => name.endsWith(extension))
    if (suffix === undefined || typeof program !== 'function') {
      throw new ErrTemplateConfiguration(
        'Cannot register compiled template: expected an HTML or text filename and a program',
      )
    }
    // A logical name can include a locale suffix. The locale is selected at lookup, so do not infer it from user filenames.
    const stem = name.slice(0, -suffix.length)
    if (stem.length <= 160) {
      assertTemplateName(stem)
    } else {
      const localeSeparator = stem.lastIndexOf('.')
      assertTemplateName(stem.slice(0, localeSeparator))
      templateLocale(stem.slice(localeSeparator + 1))
    }
    snapshot[name] = program
  }
  return Object.freeze({ entries: Object.freeze(snapshot) })
}
