import { compileFunction } from 'node:vm'

import ejs from 'ejs'

import type { TemplateCompiler } from '../../build/node/node.js'
import type { TemplateEngine } from '../../source.js'
import { renderEJS, type EJSProgram } from './runtime.js'

const extensions = Object.freeze({ html: '.ejs', text: '.txt.ejs' })

interface SourceTemplate {
  readonly source: string
  compile(): unknown
}

const Template = (
  ejs as unknown as {
    Template: new (source: string, options: Readonly<Record<string, unknown>>) => SourceTemplate
  }
).Template

function compileSource(source: string): string {
  const template = new Template(source, { strict: true, compileDebug: false, legacyInclude: false })
  template.compile()
  return template.source
}

export function ejsTemplates(): TemplateEngine {
  return {
    extensions,
    compile(asset) {
      asset.signal.throwIfAborted()
      const program = compileFunction(`"use strict";\n${compileSource(asset.source)}`, [
        'locals',
        'escapeFn',
        'include',
      ]) as EJSProgram
      return (model, context) => renderEJS(program, model, context, asset.kind)
    },
  }
}

export const ejsCompiler: TemplateCompiler = {
  extensions,
  moduleURL: import.meta.url,
  compile(asset) {
    return [
      "import { renderEJS } from './runtime.js'",
      `function program(locals, escapeFn, include) {\n${compileSource(asset.source)}\n}`,
      'export default function render(model, context) {',
      `  return renderEJS(program, model, context, ${JSON.stringify(asset.kind)})`,
      '}',
    ].join('\n')
  },
}
