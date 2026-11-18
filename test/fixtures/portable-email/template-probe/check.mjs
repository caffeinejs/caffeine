import { AwsClient } from 'aws4fetch'
import { parseFragment } from 'parse5'

import { ejsEmpty, ejsMiddle, ejsNested, ejsPage, ejsTail, templates } from './assets.mjs'
import worker from './worker.mjs'

function equal(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const partials = { middle: ejsMiddle, tail: ejsTail, empty: ejsEmpty }

function include(name, model) {
  return partials[name](model, escapeText, include)
}

export async function check() {
  const model = { name: '<one>', message: '<problem>', site: '<site>' }
  const hello = templates.hello(model)
  const plain = templates.plain()
  const nested = templates['nested/deep'](model)
  equal(hello, '<h1>Hello &lt;one&gt;</h1>\n')
  equal(plain, '<p>Static page, no model</p>\n')
  equal(nested, '<article>Deeply Nested: &lt;one&gt;</article>\n')
  equal(templates.site(model), '<footer>&lt;site&gt;</footer>\n')
  equal(templates.message(model), '<p class="err">&lt;problem&gt;</p>\n')
  equal(templates['layout-alt']({ body: hello }), '[ALT]<h1>Hello &lt;one&gt;</h1>\n[/ALT]\n')
  equal(templates.partial(model, { partials: { p: templates.hello } }), 'before <h1>Hello &lt;one&gt;</h1>\n after')
  equal(ejsPage({ text: '<html>' }, escapeText, include), '<p>EJS says &lt;html&gt;</p>\n')
  equal(ejsNested({ text: '<nested>' }, escapeText, include), '&lt;nested&gt;')
  equal(parseFragment(nested).childNodes[0].tagName, 'article')
  equal(await new Response(plain).text(), plain)

  const signer = new AwsClient({
    accessKeyId: 'SYNTHETIC',
    secretAccessKey: 'synthetic',
    service: 'ses',
    region: 'us-east-1',
  })
  const signed = await signer.sign('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails', {
    method: 'POST',
    body: '{}',
  })
  equal(signed.headers.get('authorization')?.includes('/us-east-1/ses/aws4_request'), true)
}

export default {
  async test() {
    await worker.test()
    await check()
  },
}
