import type * as fs from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { directorySource } from './directory.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>()

  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: 0 } }
})

it('opens regular assets and refuses file symlinks when the platform has no O_NOFOLLOW', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'caffeine-no-nofollow-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'asset')
  await writeFile(file, 'stored bytes')
  await symlink(file, join(root, 'alias'), 'file')
  const source = directorySource(root)

  expect(await new Response(await source.open('asset', {})).text()).toBe('stored bytes')
  await expect(source.open('alias', {})).rejects.toMatchObject({ code: 'ERR_STATIC_MANIFEST' })
})
