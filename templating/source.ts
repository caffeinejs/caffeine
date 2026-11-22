import type { ByteSize } from '@caffeinejs/std/bytes'

import type { TemplateProgram } from './compiled.js'
import { ErrTemplateConfiguration, ErrTemplateLimit } from './errors.js'

export type TemplateKind = 'html' | 'text'
export type TemplateExtensions = Readonly<Record<TemplateKind, string>>

export interface TemplateAsset {
  readonly name: string
  readonly kind: TemplateKind
  readonly locale?: string
  readonly source: string
  readonly signal: AbortSignal
}

export interface TemplateEngine {
  readonly extensions: TemplateExtensions
  compile(asset: TemplateAsset): TemplateProgram | Promise<TemplateProgram>
}

export interface TemplateSource {
  load(logicalFile: string, maxSize: ByteSize, signal: AbortSignal): Promise<string | undefined>
}

export const COMPILED_EXTENSIONS: TemplateExtensions = Object.freeze({ html: '.html', text: '.txt' })

const NAME_SEGMENT = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/
const EXTENSION = /^(?:\.[a-zA-Z0-9]+)+$/
const encoder = new TextEncoder()
export const RESERVED_TEMPLATE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

export function assertTemplateName(name: string): void {
  if (typeof name !== 'string' || name.length > 160 || !name.split('/').every(segment => NAME_SEGMENT.test(segment))) {
    throw new ErrTemplateConfiguration(
      'Cannot use template name: expected a relative logical name of at most 160 characters',
    )
  }
}

export function assertTemplateFile(name: string): void {
  if (typeof name !== 'string' || name.length > 256 || !name.split('/').every(segment => NAME_SEGMENT.test(segment))) {
    throw new ErrTemplateConfiguration('Cannot use template filename: expected a relative logical filename')
  }
}

export function assertTemplateAlias(name: string): void {
  assertTemplateName(name)
  if (RESERVED_TEMPLATE_KEYS.has(name)) {
    throw new ErrTemplateConfiguration('Cannot register template partial: alias is reserved')
  }
}

export function templateLocale(locale: string): string {
  if (typeof locale === 'string' && locale.length <= 35) {
    try {
      return new Intl.Locale(locale).baseName
    } catch {
      // Configuration errors contain no user-supplied locale.
    }
  }
  throw new ErrTemplateConfiguration('Cannot use template locale: expected a BCP 47 locale of at most 35 characters')
}

export function assertTemplateExtensions(extensions: TemplateExtensions): void {
  if (
    !extensions ||
    !EXTENSION.test(extensions.html) ||
    !EXTENSION.test(extensions.text) ||
    extensions.html === extensions.text
  ) {
    throw new ErrTemplateConfiguration(
      'Cannot use template extensions: expected distinct dot-prefixed HTML and text suffixes',
    )
  }
}

export function assertTemplateSize(value: string, maxSize: ByteSize, subject: string): number {
  if (value.length > maxSize) {
    throw new ErrTemplateLimit(`Cannot use ${subject}: content exceeds ${maxSize} bytes`)
  }
  const size = encoder.encode(value).byteLength
  if (size > maxSize) {
    throw new ErrTemplateLimit(`Cannot use ${subject}: content exceeds ${maxSize} bytes`)
  }
  return size
}

export function memoryTemplates(entries: Readonly<Record<string, string>>): TemplateSource {
  const assets = new Map(Object.entries(entries))
  for (const [name, value] of assets) {
    assertTemplateFile(name)
    if (typeof value !== 'string') {
      throw new ErrTemplateConfiguration(
        'Cannot register a memory template: expected a logical filename and UTF-8 text',
      )
    }
  }
  return {
    async load(logicalFile, maxSize, signal) {
      signal.throwIfAborted()
      const value = assets.get(logicalFile)
      if (value !== undefined) {
        assertTemplateSize(value, maxSize, 'template asset')
      }
      return value
    },
  }
}
