import { runInNewContext } from 'node:vm'

import { Byte, MiB } from '@caffeinejs/std/bytes'
import { describe, expect, it, vi } from 'vitest'

import { MANIFEST_FILE, variantPath, type ManifestFile } from '../manifest/manifest.js'
import { ErrStaticManifest, verifyStaticAssets, type StaticAssetSource } from './index.js'
import { verifyAssets } from './web.js'

const encoder = new TextEncoder()
const abc = encoder.encode('abc')
const xyz = encoder.encode('xyz')
const file: ManifestFile = {
  hash: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
  size: 3,
  lastModified: '2026-11-18T00:00:00Z',
  type: 'text/plain',
  variants: {},
}
const empty: ManifestFile = { ...file, size: 0, hash: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' }
const encodedHash = 'Ngi8oeROpsTSaOttsCJgJpiSwLQrhrvx53pvoWw8koI='
const variant = { hash: encodedHash, path: variantPath(file.hash, encodedHash, 'gzip'), size: xyz.byteLength }

function manifest(files: Record<string, ManifestFile>): Uint8Array {
  return encoder.encode(JSON.stringify({ files, version: 1 }))
}

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

function source(metadata: Uint8Array, objects = new Map<string, Uint8Array>()): StaticAssetSource {
  return {
    readManifest: async () => stream(metadata),
    async open(key) {
      const value = objects.get(key)

      if (!value) {
        throw new Error(`Missing "${key}"`)
      }
      return stream(value)
    },
  }
}

describe('verifyStaticAssets', () => {
  it('publishes only exact identity keys, verifying each reference to a shared stored variant', async () => {
    const withVariant = { ...file, variants: { gzip: variant } }
    const entries = Object.fromEntries([
      ['__proto__', withVariant],
      ['dir/café%25.txt', withVariant],
      ['empty', empty],
    ])
    const metadata = manifest(entries)
    const bodies = new Map([
      ['__proto__', abc],
      ['dir/café%25.txt', abc],
      [variant.path, xyz],
      ['empty', new Uint8Array()],
    ])
    const opened: string[] = []
    const streams: ReadableStream<Uint8Array>[] = []
    const assets = await verifyStaticAssets({
      // Both the manifest and digest inputs split across individual bytes.
      readManifest: async () => stream(...Array.from(metadata, b => Uint8Array.of(b))),
      async open(key) {
        expect(streams.every(body => !body.locked)).toBe(true)
        const body = stream(...Array.from(bodies.get(key)!, b => Uint8Array.of(b)))
        streams.push(body)
        opened.push(key)
        return body
      },
    })

    expect(assets).toMatchObject({ files: 3, variants: 2, bytes: 12 })
    expect(assets.has('__proto__')).toBe(true)
    expect(assets.has('dir/café%25.txt')).toBe(true)
    expect(assets.has('dir/café%.txt')).toBe(false)
    expect(assets.has('constructor')).toBe(false)
    expect(assets.has(variant.path)).toBe(false)
    expect(assets.has(MANIFEST_FILE)).toBe(false)
    expect(assets.has('empty')).toBe(true)
    expect(opened.toSorted()).toEqual(['__proto__', 'dir/café%25.txt', 'empty', variant.path, variant.path].toSorted())
    expect(streams.every(body => !body.locked)).toBe(true)
  })

  it('accepts an empty release and inclusive byte and entry limits', async () => {
    const metadata = manifest({})
    const assets = await verifyStaticAssets(source(metadata), { maxManifestSize: metadata.byteLength, maxEntries: 0 })

    expect(assets).toMatchObject({ files: 0, variants: 0, bytes: 0 })
    expect(assets.has('toString')).toBe(false)

    const one = manifest({ file: empty })
    const single = await verifyStaticAssets(source(one, new Map([['file', new Uint8Array()]])), {
      maxManifestSize: one.byteLength,
      maxEntries: 1,
    })
    expect(single.has('file')).toBe(true)
  })

  it('refuses one excess manifest byte before parsing and waits for cancellation before rejecting', async () => {
    const cleaned = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<unknown>()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2))
      },
      cancel(reason) {
        cancelled.resolve(reason)
        return cleaned.promise
      },
    })
    const open = vi.fn()
    const check = verifyStaticAssets({ readManifest: async () => body, open }, { maxManifestSize: Byte })
    let failure: unknown
    const settled = check.catch((err: unknown) => {
      failure = err
    })
    expect(await cancelled.promise).toBeInstanceOf(ErrStaticManifest)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(failure).toBe(undefined)
    cleaned.resolve()
    await settled
    expect(failure).toMatchObject({ message: expect.stringMatching(/static.manifest.json.*maxManifestSize.*1 bytes/) })
    expect(open).not.toHaveBeenCalled()
    expect(body.locked).toBe(false)
  })

  it('applies default byte and entry caps before opening a listed object', async () => {
    const metadata = manifest({})
    const padded = new Uint8Array(8 * MiB + Byte).fill(0x20)
    padded.set(metadata)
    expect(await verifyStaticAssets(source(padded.subarray(0, 8 * MiB)))).toMatchObject({ files: 0 })
    await expect(verifyStaticAssets(source(padded))).rejects.toThrow(/maxManifestSize/)

    const files = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [`file-${index}`, empty]))
    const open = vi.fn()
    await expect(verifyStaticAssets({ ...source(manifest(files)), open })).rejects.toThrow(/20000 identities/)
    expect(open).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, Infinity, NaN])('rejects an invalid metadata limit %s without touching storage', async limit => {
    const readManifest = vi.fn()
    const release = { readManifest, open: vi.fn() }
    await expect(verifyStaticAssets(release, { maxEntries: limit })).rejects.toThrow(/maxEntries/)
    await expect(verifyStaticAssets(release, { maxManifestSize: limit })).rejects.toThrow(/maxManifestSize/)
    expect(readManifest).not.toHaveBeenCalled()
  })

  it.each([Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xc3)])(
    'rejects malformed or truncated UTF-8 instead of accepting a replacement character',
    async invalid => {
      const first = encoder.encode('{"files":{},"version":1,"unused":"')
      const readManifest = async () => stream(first, invalid, encoder.encode('"}'))
      await expect(verifyStaticAssets({ readManifest, open: vi.fn() })).rejects.toThrow(/valid UTF-8/)
      await expect(verifyStaticAssets(source(invalid))).rejects.toThrow(/valid UTF-8/)
    },
  )

  it('rejects an invalid key before opening any of the listed representations', async () => {
    const open = vi.fn()
    await expect(
      verifyStaticAssets({ ...source(manifest({ first: file, '../outside': file })), open }),
    ).rejects.toThrow(/outside/)
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined, 'cannot be read'],
    ['short', abc.subarray(1), '2 bytes'],
    ['long', Uint8Array.of(1, 2, 3, 4), 'exceeds its declared size'],
    ['changed', xyz, 'changed after the build'],
  ] as const)('rejects a %s identity with its key and leaves later files unopened', async (_name, bytes, reason) => {
    const release = source(manifest({ first: file, next: empty }), bytes && new Map([['first', bytes]]))
    const open = vi.fn(release.open)
    const err = await verifyStaticAssets({ ...release, open }).catch((cause: unknown) => cause)
    expect(err).toBeInstanceOf(ErrStaticManifest)
    expect(err).toMatchObject({ code: 'ERR_STATIC_MANIFEST', message: expect.stringContaining('"first"') })
    expect((err as Error).message).toContain(reason)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('checks a variant against its own digest and reports the stored key', async () => {
    const metadata = manifest({ first: { ...file, variants: { gzip: variant } } })
    const err = await verifyStaticAssets(
      source(
        metadata,
        new Map([
          ['first', abc],
          [variant.path, abc],
        ]),
      ),
    ).catch((cause: unknown) => cause)
    expect(err).toMatchObject({ code: 'ERR_STATIC_MANIFEST', message: expect.stringContaining(variant.path) })
  })

  it('rejects a release when the variant check returns before reading all stored bytes', async () => {
    const cancel = vi.fn()
    const firstByte = xyz.subarray(0, 1)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstByte)
        controller.enqueue(xyz.subarray(1))
        controller.close()
      },
      cancel,
    })
    const release = {
      readManifest: async () => stream(manifest({ first: { ...file, variants: { gzip: variant } } })),
      open: async (key: string) => (key === variant.path ? body : stream(abc)),
    }

    let first: IteratorResult<Uint8Array> | undefined
    const result = verifyAssets(release, {}, async chunks => {
      first = await chunks[Symbol.asyncIterator]().next()
    })

    await expect(result).rejects.toMatchObject({ code: 'ERR_STATIC_MANIFEST' })
    expect(first).toEqual({ done: false, value: firstByte })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it('stops the representation read at the first excess chunk and cancels it once', async () => {
    const cancel = vi.fn()
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(abc))
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    const release = source(manifest({ first: empty }))
    await expect(verifyStaticAssets({ ...release, open: async () => body })).rejects.toThrow(/exceeds.*0 bytes/)
    expect(pull).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it('releases an errored stream and includes the key in the failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('provider failure'))
      },
    })
    await expect(verifyStaticAssets({ ...source(manifest({ first: file })), open: async () => body })).rejects.toThrow(
      /"first" cannot be read/,
    )
    expect(body.locked).toBe(false)
  })

  it('rejects a pre-aborted release without calling the provider', async () => {
    const reason = new Error('release superseded')
    const readManifest = vi.fn()
    await expect(
      verifyStaticAssets({ readManifest, open: vi.fn() }, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason)
    expect(readManifest).not.toHaveBeenCalled()
  })

  it.each(['manifest', 'object'])(
    'rejects a pending %s acquisition and cancels a late stream with the reason',
    async stage => {
      const abort = new AbortController()
      const requested = Promise.withResolvers<AbortSignal | undefined>()
      const returned = Promise.withResolvers<ReadableStream<Uint8Array>>()
      const pending = (signal?: AbortSignal) => {
        requested.resolve(signal)
        return returned.promise
      }
      const release = source(manifest({ file }))
      const result = verifyStaticAssets(
        {
          readManifest: stage === 'manifest' ? pending : release.readManifest,
          open: (_key, options) => pending(options.signal),
        },
        { signal: abort.signal },
      )

      expect(await requested.promise).toBe(abort.signal)
      abort.abort(new Error('release superseded'))
      await expect(result).rejects.toBe(abort.signal.reason)

      const cancelled = Promise.withResolvers<unknown>()
      const cancel = vi.fn((reason: unknown) => cancelled.resolve(reason))
      const late = new ReadableStream<Uint8Array>({ cancel })
      returned.resolve(late)

      expect(await cancelled.promise).toBe(abort.signal.reason)
      await vi.waitFor(() => expect(late.locked).toBe(false))
      expect(cancel).toHaveBeenCalledTimes(1)
    },
  )

  it('releases a late stream even while its provider is still acknowledging cancellation', async () => {
    const abort = new AbortController()
    const opened = Promise.withResolvers<ReadableStream<Uint8Array>>()
    const cancelled = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const release = verifyStaticAssets({ readManifest: () => opened.promise, open: vi.fn() }, { signal: abort.signal })
    abort.abort()
    await expect(release).rejects.toBe(abort.signal.reason)

    const late = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.resolve()
        return cleanup.promise
      },
    })
    opened.resolve(late)
    await cancelled.promise
    try {
      expect(late.locked).toBe(false)
    } finally {
      cleanup.resolve()
    }
  })

  it.each(['manifest', 'object'])(
    'aborting a stalled %s read cancels the acquired stream exactly once',
    async stage => {
      const abort = new AbortController()
      const reading = Promise.withResolvers<void>()
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve()
          },
          cancel,
        },
        { highWaterMark: 0 },
      )
      const release = source(manifest({ file }))
      const result = verifyStaticAssets(
        {
          readManifest: stage === 'manifest' ? async () => body : release.readManifest,
          open: async () => body,
        },
        { signal: abort.signal },
      )

      await reading.promise
      abort.abort(new Error('candidate retired'))

      await expect(result).rejects.toBe(abort.signal.reason)
      expect(cancel).toHaveBeenCalledExactlyOnceWith(abort.signal.reason)
      await vi.waitFor(() => expect(body.locked).toBe(false))
    },
  )
})

describe('verified Fetch responses', () => {
  it('selects exact keys, ranges and stored variants without opening bodyless responses', async () => {
    const metadata = manifest({ 'café%.txt': { ...file, variants: { gzip: variant } } })
    const fallback = source(
      metadata,
      new Map([
        ['café%.txt', abc],
        [variant.path, xyz],
      ]),
    )
    const open = vi.fn<StaticAssetSource['open']>((key, options) =>
      options.range
        ? Promise.resolve(stream(abc.subarray(options.range.start, options.range.endExclusive)))
        : fallback.open(key, options),
    )
    const assets = await verifyStaticAssets({ ...fallback, open })
    open.mockClear()
    const respond = (headers: Record<string, string> = {}, method = 'GET', key = 'café%.txt') =>
      assets.respond(new Request('https://example.test/unrelated', { method, headers }), key)

    const wrongMethod = await respond({}, 'POST', 'missing')
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD')
    expect((await respond({}, 'GET', 'caf%C3%A9%25.txt')).status).toBe(404)
    const refused = await respond({ 'accept-encoding': 'identity;q=0' })
    expect(refused.status).toBe(406)
    expect(refused.headers.get('vary')).toBe('Accept-Encoding')
    const head = await respond({ 'accept-encoding': 'gzip', range: 'bytes=1-' }, 'HEAD')
    expect(head.headers.get('content-encoding')).toBe('gzip')
    expect(head.headers.get('content-length')).toBe('3')
    expect(head.body).toBe(null)
    const fresh = await respond({ 'accept-encoding': 'gzip', 'if-none-match': head.headers.get('etag')! })
    expect(fresh.status).toBe(304)
    expect(fresh.body).toBe(null)
    expect(fresh.headers.get('cache-control')).toBe('private, no-cache')
    expect((await respond({ 'if-match': '"wrong"' })).status).toBe(412)
    const unsatisfiable = await respond({ range: 'bytes=3-' })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */3')
    expect(open).not.toHaveBeenCalled()

    const part = await respond({ range: 'bytes=2-' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-2/3')
    expect(await part.text()).toBe('c')
    expect(open).toHaveBeenLastCalledWith(
      'café%.txt',
      expect.objectContaining({ range: { start: 2, endExclusive: 3 } }),
    )
    const encoded = await respond({ 'accept-encoding': 'gzip' })
    expect(await encoded.bytes()).toEqual(xyz)
    expect(open).toHaveBeenLastCalledWith(variant.path, expect.objectContaining({ range: undefined }))
  })

  it.each(['a', 'abc'])(
    'errors a range body when the provider returns %s instead of the requested bytes',
    async bytes => {
      const backing = source(manifest({ file }), new Map([['file', abc]]))
      const assets = await verifyStaticAssets({
        ...backing,
        open: (key, options) =>
          options.range ? Promise.resolve(stream(encoder.encode(bytes))) : backing.open(key, options),
      })
      const response = await assets.respond(
        new Request('https://example.test', { headers: { range: 'bytes=1-' } }),
        'file',
      )
      expect(response.status).toBe(206)
      await expect(response.bytes()).rejects.toBeInstanceOf(Error)
    },
  )

  it('accepts byte views from another realm throughout verification and serving', async () => {
    const view: Uint8Array = runInNewContext('Uint8Array.of(0, 97, 98, 99, 0).subarray(1, 4)')
    const assets = await verifyStaticAssets(source(manifest({ file }), new Map([['file', view]])))
    const response = await assets.respond(new Request('https://example.test'), 'file')
    expect(await response.text()).toBe('abc')
  })

  it('returns a generic no-store 500 when the verified source fails to open', async () => {
    const release = source(manifest({ file }), new Map([['file', abc]]))
    const open = vi.fn(release.open)
    const assets = await verifyStaticAssets({ ...release, open })
    open.mockRejectedValueOnce(new Error('storage account details'))
    const response = await assets.respond(new Request('https://example.test'), 'file')
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.body).toBe(null)
  })

  it('cancels a late response open with the request abort reason', async () => {
    const backing = source(manifest({ file }), new Map([['file', abc]]))
    const pending = Promise.withResolvers<ReadableStream<Uint8Array>>()
    const opening = Promise.withResolvers<void>()
    let verify = true
    const assets = await verifyStaticAssets({
      ...backing,
      open: (key, options) => {
        if (verify) {
          return backing.open(key, options)
        }
        opening.resolve()
        return pending.promise
      },
    })
    verify = false
    const controller = new AbortController()
    const answer = assets.respond(new Request('https://example.test', { signal: controller.signal }), 'file')
    const reason = new Error('superseded')
    await opening.promise
    controller.abort(reason)
    await expect(answer).rejects.toBe(reason)
    const cancelled = Promise.withResolvers<unknown>()
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled.resolve }, { highWaterMark: 0 })
    pending.resolve(body)
    expect(await cancelled.promise).toBe(reason)
    expect(body.locked).toBe(false)
  })

  it.each([false, true])('releases an acquired response stream once with request abort=%s', async abort => {
    const backing = source(manifest({ file }), new Map([['file', abc]]))
    const cancel = vi.fn()
    const started = Promise.withResolvers<void>()
    const body = new ReadableStream<Uint8Array>({ pull: () => started.resolve(), cancel }, { highWaterMark: 0 })
    let verify = true
    const assets = await verifyStaticAssets({
      ...backing,
      open: (key, options) => (verify ? backing.open(key, options) : Promise.resolve(body)),
    })
    verify = false
    const controller = new AbortController()
    const response = await assets.respond(new Request('https://example.test', { signal: controller.signal }), 'file')
    const reader = response.body!.getReader()
    const next = reader.read()
    await started.promise
    const reason = new Error('client left')
    if (abort) {
      controller.abort(reason)
      await expect(next).rejects.toBe(reason)
    } else {
      await reader.cancel(reason)
      await expect(next).resolves.toEqual({ done: true, value: undefined })
    }
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
    expect(body.locked).toBe(false)
  })
})
