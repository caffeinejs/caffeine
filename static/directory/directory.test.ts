import { mkdir, mkdtemp, open, rm, symlink, truncate, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANIFEST_FILE } from '../manifest/manifest.js'
import { directorySource } from './directory.js'

vi.mock(import('node:fs/promises'), async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, open: vi.fn(actual.open) }
})

describe('directorySource', () => {
  let workspace: string
  let root: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'caffeine-directory-'))
    root = join(workspace, 'release')
    await mkdir(root)
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('opens supplementary Unicode names and refuses keys that would alias the replacement character', async () => {
    await writeFile(join(root, '\ufffd'), 'replacement')
    await writeFile(join(root, '📁'), 'folder')
    const source = directorySource(root)

    await expect(source.open('\ud800', {})).rejects.toThrow('ill-formed Unicode')
    expect(await new Response(await source.open('📁', {})).text()).toBe('folder')
  })

  it('reads the manifest and raw storage bytes without interpreting a key as a URL', async () => {
    const key = '.static-variants/é%2F.gz'
    const compressed = Uint8Array.of(31, 139, 8, 0, 255)
    await mkdir(join(root, '.static-variants'))
    await writeFile(join(root, key), compressed)
    await writeFile(join(root, MANIFEST_FILE), 'manifest')
    const source = directorySource(root)

    expect(await new Response(await source.readManifest()).text()).toBe('manifest')
    expect(new Uint8Array(await new Response(await source.open(key, {})).arrayBuffer())).toEqual(compressed)
  })

  it('keeps reading the original release when its launch alias switches releases', async () => {
    const current = join(workspace, 'current')
    const next = join(workspace, 'next')
    await mkdir(next)
    await writeFile(join(root, 'asset'), 'first')
    await writeFile(join(next, 'asset'), 'next')
    await symlink(root, current, 'dir')
    const source = directorySource(current)
    await unlink(current)
    await symlink(next, current, 'dir')

    expect(await new Response(await source.open('asset', {})).text()).toBe('first')
  })

  it('returns exact half-open intervals, including zero bytes at EOF and an empty identity', async () => {
    await writeFile(join(root, 'asset'), '0123456789')
    await writeFile(join(root, 'empty'), '')
    const source = directorySource(root)

    for (const [start, endExclusive, expected] of [
      [0, 1, '0'],
      [3, 8, '34567'],
      [9, 10, '9'],
      [10, 10, ''],
    ] as const) {
      const stream = await source.open('asset', { range: { start, endExclusive } })
      expect(await new Response(stream).text()).toBe(expected)
    }
    expect(await new Response(await source.open('empty', {})).text()).toBe('')
  })

  it('rejects an interval that cannot deliver the requested count', async () => {
    await writeFile(join(root, 'asset'), '0123')
    const source = directorySource(root)
    for (const [start, endExclusive] of [
      [-1, 1],
      [3, 2],
      [4, 5],
      [0, 1.5],
      [0, NaN],
      [Infinity, Infinity],
    ] as const) {
      await expect(source.open('asset', { range: { start, endExclusive } })).rejects.toMatchObject({
        code: 'ERR_STATIC_MANIFEST',
        message: expect.stringContaining('invalid byte range'),
      })
    }
  })

  it('rejects missing files, directories and invalid storage keys', async () => {
    await mkdir(join(root, 'assets'))
    await writeFile(join(root, 'asset'), 'contents')
    const source = directorySource(root)
    for (const key of [
      'absent',
      'assets',
      './asset',
      'assets/../asset',
      '/asset',
      'assets//file',
      'assets\\file',
      'a:b',
      'e\u0301',
    ]) {
      await expect(source.open(key, {})).rejects.toMatchObject({ code: 'ERR_STATIC_MANIFEST' })
    }
    await expect(source.readManifest()).rejects.toMatchObject({
      code: 'ERR_STATIC_MANIFEST',
      message: expect.stringContaining(MANIFEST_FILE),
    })
    expect(() => directorySource(join(root, 'asset'))).toThrow('the root is not a directory')
  })

  it('refuses to bind a release that has not been staged', () => {
    expect(() => directorySource(join(workspace, 'missing'))).toThrow(
      expect.objectContaining({ code: 'ERR_STATIC_MANIFEST' }),
    )
  })

  it('resolves parent aliases inside the bound release and refuses file symlinks for assets and the manifest', async () => {
    await mkdir(join(root, 'inside'))
    await writeFile(join(root, 'inside', 'asset'), 'inside')
    await symlink(join(root, 'inside'), join(root, 'alias'), 'dir')
    await symlink(join(root, 'inside', 'asset'), join(root, 'file'))
    await symlink(join(root, 'inside', 'asset'), join(root, MANIFEST_FILE))
    const source = directorySource(root)
    expect(await new Response(await source.open('alias/asset', {})).text()).toBe('inside')
    await expect(source.open('file', {})).rejects.toMatchObject({ code: 'ERR_STATIC_MANIFEST' })
    await expect(source.readManifest()).rejects.toMatchObject({ code: 'ERR_STATIC_MANIFEST' })

    const sibling = join(workspace, 'release-old')
    await mkdir(sibling)
    await writeFile(join(sibling, 'asset'), 'outside')
    await unlink(join(root, 'alias'))
    await symlink(sibling, join(root, 'alias'), 'dir')
    await expect(source.open('alias/asset', {})).rejects.toMatchObject({
      code: 'ERR_STATIC_MANIFEST',
      message: expect.stringContaining('resolves outside the root'),
    })
  })

  it('reports a short read when an opened object loses its promised bytes', async () => {
    await writeFile(join(root, 'asset'), '0123456789')
    const stream = await directorySource(root).open('asset', { range: { start: 2, endExclusive: 8 } })
    await truncate(join(root, 'asset'), 1)
    await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
      code: 'ERR_STATIC_MANIFEST',
      message: expect.stringContaining('ended before its checked length'),
    })
  })

  it('propagates abort before and after opening and permits cancelling a partially read file', async () => {
    const bytes = new Uint8Array(256 * 1024).fill(0x75)
    await writeFile(join(root, 'asset'), bytes)
    const source = directorySource(root)
    const aborter = new AbortController()
    const reader = (await source.open('asset', { signal: aborter.signal })).getReader()
    const first = (await reader.read()).value!
    expect(first.byteLength).toBeLessThan(bytes.byteLength)
    expect(first).toEqual(bytes.subarray(0, first.byteLength))
    const reason = new Error('release read cancelled')
    aborter.abort(reason)
    await expect(reader.read()).rejects.toBe(reason)
    await expect(source.open('asset', { signal: aborter.signal })).rejects.toBe(reason)
    await expect(source.readManifest(aborter.signal)).rejects.toBe(reason)

    const again = (await source.open('asset', {})).getReader()
    expect((await again.read()).done).toBe(false)
    await again.cancel()
    expect(await again.read()).toEqual({ done: true, value: undefined })
  })

  it('completes pending reads without delivering more bytes once the caller cancels', async () => {
    await writeFile(join(root, 'asset'), 'u')
    const reading = Promise.withResolvers<void>()
    const finishRead = Promise.withResolvers<void>()
    const close = vi.fn(() => finishRead.promise)
    vi.mocked(open).mockResolvedValueOnce({
      stat: async () => ({ size: 1, isFile: () => true }),
      async read(buffer: Uint8Array) {
        reading.resolve()
        await finishRead.promise
        buffer[0] = 0x75
        return { bytesRead: 1, buffer }
      },
      close,
    } as unknown as FileHandle)

    const reader = (await directorySource(root).open('asset', {})).getReader()
    const pending = reader.read()
    await reading.promise
    const settled = vi.fn()
    const cancelled = reader.cancel().then(settled)
    try {
      expect(await pending).toEqual({ done: true, value: undefined })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).not.toHaveBeenCalled()
    } finally {
      finishRead.resolve()
      await cancelled
      reader.releaseLock()
    }
    expect(settled).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
