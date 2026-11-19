# Caffeine Templating

Render HTML and plain text from application code, a background job, or a Fetch handler. The root import uses Web APIs and works with standalone template programs on Node, Bun, and workers.

## Render your first template

Install `@caffeinejs/templating` and its peer `@caffeinejs/std`. Register a group of template programs. The filename suffix selects the output kind. A locale-qualified filename such as `welcome.pt-BR.html` is tried before the language-level and unqualified filenames.

```ts
import { compiledTemplates, html, TemplateRenderer } from '@caffeinejs/templating'

const renderer = new TemplateRenderer({
  default: compiledTemplates({
    'welcome.html': model => html`<p>Hello, ${String(model.name)}!</p>`,
    'welcome.txt': model => `Hello, ${String(model.name)}!`,
  }),
})

await renderer.render('welcome', { name: '<Ada>' })
await renderer.render('welcome', { name: '<Ada>' }, { kind: 'text' })
```

Rendering accepts an optional `signal`. A group may define default data, a default HTML layout, and partial aliases for each kind. A render can override the layout or disable it with `layout: false`. Layouts receive the rendered `body` along with the page model.

The `html` tag escapes text and supported quoted attributes. Use explicit closing tags for nonvoid elements. Interpolated `href` and `src` values must fill a quoted attribute and come from `httpsURL(...)`. Use `unsafeHTML(...)` only for trusted markup. A program's returned HTML string is also trusted markup. Pass request data through the tag's substitutions.

## Render file templates in development

Import the file loader and the compiler you use from their Node entries. Install the corresponding optional engine peer.

```ts
import { fileURLToPath } from 'node:url'

import { TemplateRenderer } from '@caffeinejs/templating'
import { fileTemplates } from '@caffeinejs/templating/file/node'
import { handlebarsTemplates } from '@caffeinejs/templating/handlebars/node'

const renderer = new TemplateRenderer({
  default: {
    source: fileTemplates(fileURLToPath(new URL('./templates/', import.meta.url))),
    engine: handlebarsTemplates(),
    cache: false,
  },
})
```

Pass application-owned directories to `fileTemplates(...)`. Runtime compilers execute application-authored templates as trusted code. Handlebars uses `.hbs` and `.txt.hbs`. EJS uses `.ejs` and `.txt.ejs`, with explicit locals such as `<%= locals.name %>`. Declare partial aliases in the group and reference them by alias. Apply raw insertion only to authored markup, for example a rendered layout body.

## Precompile for deployment

Install `esbuild`, `es-module-lexer`, and your compiler peer on the build host. The built-in selectors are `'handlebars'` and `'ejs'`. `buildTemplates(...)` also accepts an application-supplied `TemplateCompiler` object.

```ts
import { buildTemplates } from '@caffeinejs/templating/build/node'

await buildTemplates({
  engine: 'handlebars',
  roots: ['./templates'],
  assets: [{ name: 'welcome', kind: 'html', locales: ['pt-BR'] }],
  outFile: './generated/welcome.mjs',
})
```

A third-party compiler declares two extensions and its module URL. It receives a single source variant and returns ESM with a default synchronous render function. The builder bundles its portable helper imports relative to that module URL.

```ts
import type { TemplateCompiler } from '@caffeinejs/templating/build/node'

export const literalCompiler = {
  extensions: { html: '.literal', text: '.txt.literal' },
  moduleURL: import.meta.url,
  compile({ source }) {
    return `export default function render() {\n  return ${JSON.stringify(source)}\n}\n`
  },
} satisfies TemplateCompiler
```

Use static module imports for runtime helpers. Emitted render programs return primitive strings, use the provided context to resolve declared partials, and must run without filesystem access or dynamic code generation. Deploy the generated manifest with the portable package. The compiler and original sources stay in the build environment.

```ts
import { compiledTemplates, TemplateRenderer } from '@caffeinejs/templating'

import { entries, partials } from './generated/welcome.mjs'

export const renderer = new TemplateRenderer({
  default: { ...compiledTemplates(entries), partials },
})
```

## Install in a Caffeine application

Import `Templating` from `@caffeinejs/templating/caffeine` and install it with `.install(Templating(t => t.add(group)))`. Resolve `TemplateRenderer` from the application container. For a named group use `t.add('mail', group)` and select it with `{ renderer: 'mail' }` when rendering.

Supply configuration with `t.config(settings)`. Explicit settings in `add(...)` win, and individual limit fields merge. The application gives the feature a configuration snapshot during bootstrap.
