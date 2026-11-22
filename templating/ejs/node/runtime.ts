import type { TemplateContext, TemplateModel } from '../../compiled.js'

export type EJSProgram = (
  locals: TemplateModel,
  escapeFn: (value: unknown) => string,
  include: (alias: string, model?: TemplateModel) => string,
) => string

export function renderEJS(
  program: EJSProgram,
  model: TemplateModel,
  context: TemplateContext,
  kind: 'html' | 'text',
): string {
  context.signal.throwIfAborted()
  const locals = copyLocals(model)
  return program(locals, kind === 'text' ? literal : escapeHTML, (alias, additional) => {
    const merged = Object.assign(
      Object.create(null),
      locals,
      additional === undefined ? undefined : copyLocals(additional),
    )
    return context.partial(alias, merged)
  })
}

function copyLocals(model: TemplateModel): TemplateModel {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new TypeError('Cannot render EJS: locals must be an object')
  }
  const locals: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(model)) {
    const property = Object.getOwnPropertyDescriptor(model, key)!
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !('value' in property)) {
      throw new TypeError('Cannot render EJS: locals contain an unsafe property')
    }
    locals[key] = property.value
  }
  return locals
}

function literal(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function escapeHTML(value: unknown): string {
  return literal(value).replace(/[&<>"']/g, character => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&#34;'
      default:
        return '&#39;'
    }
  })
}
