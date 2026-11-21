import type { TemplateDelegate } from 'handlebars'

import type { TemplateContext, TemplateModel } from '../../compiled.js'
import { httpsURL } from '../../html/url.js'

export function renderHandlebars(template: TemplateDelegate, model: TemplateModel, context: TemplateContext): string {
  context.signal.throwIfAborted()
  const partials: Record<string, (model: TemplateModel) => string> = Object.create(null)
  for (const alias of context.partials) {
    partials[alias] = partialModel => context.partial(alias, partialModel)
  }
  return template(model, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
    partials,
    helpers: {
      httpsURL(value: string | URL) {
        return httpsURL(value).toString()
      },
    },
  })
}
