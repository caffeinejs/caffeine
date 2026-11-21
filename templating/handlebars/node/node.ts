import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import handlebars from 'handlebars'

import type { TemplateCompiler } from '../../build/node/node.js'
import type { TemplateEngine } from '../../source.js'
import { renderHandlebars } from './runtime.js'

const extensions = Object.freeze({ html: '.hbs', text: '.txt.hbs' })
const require = createRequire(import.meta.url)

export function handlebarsTemplates(): TemplateEngine {
  const instance = handlebars.create()
  return {
    extensions,
    compile(asset) {
      asset.signal.throwIfAborted()
      const template = instance.compile(instance.parse(asset.source), { noEscape: asset.kind === 'text' })
      return (model, context) => renderHandlebars(template, model, context)
    },
  }
}

export const handlebarsCompiler: TemplateCompiler = {
  extensions,
  moduleURL: import.meta.url,
  async compile(asset) {
    const source = handlebars.precompile(asset.source, { noEscape: asset.kind === 'text' })
    const license = await readFile(require.resolve('handlebars/LICENSE'), 'utf8')
    return [
      `/*! @license Handlebars\n${license.replaceAll('*/', '* /')}\n*/`,
      "import runtime from 'handlebars/runtime.js'",
      "import { renderHandlebars } from './runtime.js'",
      `const template = runtime.create().template(${source})`,
      'export default function render(model, context) {',
      '  return renderHandlebars(template, model, context)',
      '}',
    ].join('\n')
  },
}
