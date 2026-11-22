import { expectTypeOf } from 'vitest'

import type { TemplateProgram } from '../../compiled.js'
import { buildTemplates, type BuildTemplatesOptions, type TemplateCompiler } from './index.js'

const compiler: TemplateCompiler = {
  extensions: { html: '.receipt', text: '.txt.receipt' },
  moduleURL: import.meta.url,
  async compile(asset) {
    expectTypeOf(asset.name).toEqualTypeOf<string>()
    expectTypeOf(asset.kind).toEqualTypeOf<'html' | 'text'>()
    expectTypeOf(asset.locale).toEqualTypeOf<string | undefined>()
    expectTypeOf(asset.source).toEqualTypeOf<string>()
    return 'export default model => String(model.name)'
  },
}

expectTypeOf(buildTemplates).returns.toEqualTypeOf<Promise<void>>()
expectTypeOf(compiler).toExtend<TemplateCompiler>()
expectTypeOf<'ejs'>().toExtend<BuildTemplatesOptions['engine']>()
expectTypeOf<'handlebars'>().toExtend<BuildTemplatesOptions['engine']>()

const invalidSelector: BuildTemplatesOptions = {
  // @ts-expect-error Only the two built-in shorthand selectors are accepted.
  engine: 'unknown',
  roots: '.',
  assets: [{ name: 'welcome', kind: 'html' }],
  outFile: 'templates.mjs',
}
void invalidSelector

const wrongContract: TemplateCompiler = {
  extensions: { html: '.receipt', text: '.txt.receipt' },
  moduleURL: import.meta.url,
  // @ts-expect-error A build compiler returns ESM module source, not a runtime render callable.
  compile(): TemplateProgram {
    return () => 'Hello'
  },
}
void wrongContract
