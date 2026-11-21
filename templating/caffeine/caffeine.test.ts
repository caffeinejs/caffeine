import { createApplication } from '@caffeinejs/application'
import { Byte } from '@caffeinejs/std/bytes'
import { expect, it } from 'vitest'

import { compiledTemplates, ErrTemplateConfiguration, ErrTemplateLimit, TemplateRenderer } from '../index.js'
import { Templating } from './index.js'

const group = compiledTemplates({
  'page.html': () => 'abc',
  'layout.html': model => `<p>${model.body}</p>`,
})

it.each([true, false])('binds a renderer and applies options independently of call order (%s)', async settingsFirst => {
  const settings = {
    default: { layout: 'layout', cache: { maxEntries: 4 }, limits: { maxOutputSize: 3 * Byte } },
    named: { mail: { layout: 'layout' } },
  }
  const app = createApplication({ logger: false }).install(
    Templating(builder => {
      if (settingsFirst) {
        builder.config(settings)
      }
      builder.add({ ...group, layout: false, cache: false, limits: { maxPartials: 2 } }).add('mail', group)
      if (!settingsFirst) {
        builder.config(settings)
      }
      settings.named.mail.layout = 'missing'
    }),
  )
  await app.bootstrap()
  try {
    const renderer = app.container.get(TemplateRenderer)
    expect(await renderer.render('page')).toBe('abc')
    expect(await renderer.render('page', {}, { renderer: 'mail' })).toBe('<p>abc</p>')
    await expect(renderer.render('page', {}, { layout: 'layout' })).rejects.toBeInstanceOf(ErrTemplateLimit)
  } finally {
    await app.close()
  }
})

it('accepts a named-only renderer but rejects configuration for unregistered groups', async () => {
  const app = createApplication({ logger: false }).install(Templating(builder => builder.add('mail', group)))
  await app.bootstrap()
  try {
    const renderer = app.container.get(TemplateRenderer)
    expect(await renderer.render('page', {}, { renderer: 'mail' })).toBe('abc')
    await expect(renderer.render('page')).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  } finally {
    await app.close()
  }

  const unknown = createApplication({ logger: false }).install(
    Templating(builder => builder.add(group).config({ named: { mail: { layout: 'layout' } } })),
  )
  await expect(unknown.bootstrap()).rejects.toBeInstanceOf(ErrTemplateConfiguration)
  await unknown.close()
})
