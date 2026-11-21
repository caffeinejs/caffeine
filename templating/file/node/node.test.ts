import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Byte, KiB } from '@caffeinejs/std/bytes'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ErrTemplateConfiguration, ErrTemplateLimit } from '../../errors.js'
import { fileTemplates } from './node.js'

describe('file template source', () => {
  let directory: string
  let first: string
  let second: string
  const signal = new AbortController().signal

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'caffeine-templates-'))
    first = join(directory, 'first')
    second = join(directory, 'second')
    await mkdir(first)
    await mkdir(second)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('resolves roots in order and preserves an empty first match', async () => {
    await writeFile(join(first, 'welcome.hbs'), '')
    await writeFile(join(second, 'welcome.hbs'), 'fallback')
    await writeFile(join(second, 'second.hbs'), 'second')
    const source = fileTemplates([first, second])
    expect(await source.load('welcome.hbs', 1 * KiB, signal)).toBe('')
    expect(await source.load('second.hbs', 1 * KiB, signal)).toBe('second')
    expect(await source.load('missing.hbs', 1 * KiB, signal)).toBe(undefined)
  })

  it('decodes strict UTF-8 and rejects malformed bytes', async () => {
    await writeFile(join(first, 'valid.hbs'), 'héllo 🫖')
    await writeFile(join(first, 'invalid.hbs'), new Uint8Array([0xc3, 0x28]))
    const source = fileTemplates(first)
    expect(await source.load('valid.hbs', 1 * KiB, signal)).toBe('héllo 🫖')
    await expect(source.load('invalid.hbs', 1 * KiB, signal)).rejects.toMatchObject({
      code: 'ERR_TEMPLATE_CONFIGURATION',
    })
  })

  it('limits bytes rather than decoded character count', async () => {
    await writeFile(join(first, 'valid.hbs'), 'é')
    const source = fileTemplates(first)
    expect(await source.load('valid.hbs', 2 * Byte, signal)).toBe('é')
    await expect(source.load('valid.hbs', 1 * Byte, signal)).rejects.toBeInstanceOf(ErrTemplateLimit)
  })

  it('refuses traversal, absolute names and symlinks outside the root', async () => {
    await writeFile(join(second, 'private.hbs'), 'private')
    await symlink(join(second, 'private.hbs'), join(first, 'escaped.hbs'))
    const source = fileTemplates(first)
    for (const name of ['../second/private.hbs', join(second, 'private.hbs'), 'escaped.hbs']) {
      await expect(source.load(name, 1 * KiB, signal)).rejects.toBeInstanceOf(ErrTemplateConfiguration)
    }
  })

  it('allows nested assets and symlinks that stay inside the root', async () => {
    await mkdir(join(first, 'nested'))
    await writeFile(join(first, 'nested', 'page.hbs'), 'nested')
    await symlink(join(first, 'nested', 'page.hbs'), join(first, 'linked.hbs'))
    const source = fileTemplates(first)
    expect(await source.load('nested/page.hbs', 1 * KiB, signal)).toBe('nested')
    expect(await source.load('linked.hbs', 1 * KiB, signal)).toBe('nested')
  })

  it('accepts a maximum-length logical name with its locale and extension suffix', async () => {
    const file = `${'a'.repeat(160)}.pt-BR.txt.hbs`
    await writeFile(join(first, file), 'localized text')
    expect(await fileTemplates(first).load(file, 1 * KiB, signal)).toBe('localized text')
  })

  it('refuses an aborted read before accessing the source', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancelled')
    controller.abort(reason)
    await expect(fileTemplates(first).load('missing.hbs', 1 * KiB, controller.signal)).rejects.toBe(reason)
  })

  it('refuses directories and invalid root or limit configuration', async () => {
    await mkdir(join(first, 'directory.hbs'))
    expect(() => fileTemplates([])).toThrow(ErrTemplateConfiguration)
    await expect(fileTemplates(first).load('directory.hbs', 1 * KiB, signal)).rejects.toBeInstanceOf(
      ErrTemplateConfiguration,
    )
    await expect(fileTemplates(first).load('page.hbs', -1 * Byte, signal)).rejects.toBeInstanceOf(
      ErrTemplateConfiguration,
    )
  })
})
