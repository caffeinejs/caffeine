const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ejs = require('ejs')
const { precompile } = require('handlebars')

const fixtureRoot = 'view/_tests/_testdata'
const programs = ['import runtime from "handlebars/runtime.js"', 'export const templates = Object.create(null)']
for (const name of ['hello', 'layout-alt', 'message', 'nested/deep', 'plain', 'site']) {
  const source = readFileSync(join(fixtureRoot, 'templates', `${name}.hbs`), 'utf8')
  programs.push(`templates[${JSON.stringify(name)}] = runtime.template(${precompile(source)})`)
}

programs.push(`templates.partial = runtime.template(${precompile('before {{> p}} after')})`)

const page = readFileSync(join(fixtureRoot, 'templates-ejs', 'page.ejs'), 'utf8')
const ejsSources = {
  ejsPage: page.replace('<%= text %>', '<%= locals.text %>'),
  ejsNested: '<%- include("middle", locals) %><%- include("empty", locals) %>',
  ejsMiddle: '<%- include("tail", locals) %>',
  ejsTail: '<%= locals.text %>',
  ejsEmpty: '',
}
for (const [name, source] of Object.entries(ejsSources)) {
  // EJS 6's compiled wrapper closes over the compiler. Its generated body accepts explicit render helpers.
  const template = new ejs.Template(source, { strict: true, compileDebug: false, legacyInclude: false })
  template.compile()
  programs.push(`export function ${name}(locals, escapeFn, include) {\n${template.source}\n}`)
}

process.stdout.write(programs.join('\n') + '\n')
