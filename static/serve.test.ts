import { cp, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { ErrHTTPNotAcceptable, ErrHTTPPreconditionFailed, type WebApplication } from '@caffeinejs/http'
import { createWebApplication, newRouter } from '@caffeinejs/http/fastify'
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import { buildStatic } from './build/build.js'
import { ErrStaticManifest, readManifest, type StaticManifest } from './manifest/manifest.js'
import { sendFile } from './send.js'
import { prepareFile, rootOnDisk, serveFile, type FilePolicy, type PreparedFile, type ServeOptions } from './serve.js'
import { staticFiles } from './static.js'

const { spa } = inject('fixtures')

const POLICY: FilePolicy = {
  routeCacheControl: () => 'public, no-cache',
  sendFileCacheControl: () => 'private, no-cache',
  headers: () => undefined,
}

const SILENT = { error: () => undefined }
const ROUTE: ServeOptions = { via: 'route', conditional: true, log: SILENT }

const request = (headers: Record<string, string> = {}, method = 'GET') => ({
  method,
  header: (name: string) => headers[name],
})

async function text(body: Readable | undefined): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of body!) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString()
}

describe('serveFile', () => {
  let manifest: StaticManifest
  let page: PreparedFile
  let icon: PreparedFile

  beforeAll(async () => {
    manifest = await readManifest(spa)
    const disk = rootOnDisk(spa)
    page = prepareFile(disk, 'index.html', manifest.files['index.html']!, POLICY)
    icon = prepareFile(disk, 'favicon.svg', manifest.files['favicon.svg']!, POLICY)
  })

  // Computed once at start-up: a request only picks one of these objects.
  it('computes the headers of every representation, Vary on each, a file without variants included', () => {
    const entry = manifest.files['index.html']!

    expect(page.identity.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(entry.size),
      etag: `"${entry.hash}"`,
      'last-modified': new Date(entry.lastModified).toUTCString(),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      vary: 'Accept-Encoding',
    })
    expect(page.encodings).toEqual(['br', 'gzip'])
    expect(page.variants[0]!.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(entry.variants.br!.size),
      etag: `"${entry.variants.br!.hash}"`,
      'last-modified': new Date(entry.lastModified).toUTCString(),
      'x-content-type-options': 'nosniff',
      'content-encoding': 'br',
      vary: 'Accept-Encoding',
    })
    // Without a variant, Accept-Encoding still decides between the file and a 406, so a shared cache must key on it,
    // on the 304 that refreshes its copy too.
    expect(icon.identity.headers.vary).toBe('Accept-Encoding')
    expect(icon.identity.notModified.vary).toBe('Accept-Encoding')
  })

  // Each representation is its own tag: a client holding the gzip copy that now asks for brotli needs the body.
  it('answers 304 to the tag of the representation selected, with Vary, and 200 to a sibling', async () => {
    const br = page.variants[0]!.headers.etag!
    const gzip = page.variants[1]!.headers.etag!

    const fresh = await serveFile(page, request({ 'accept-encoding': 'br', 'if-none-match': br }), ROUTE)
    const stale = await serveFile(page, request({ 'accept-encoding': 'br', 'if-none-match': gzip }), ROUTE)

    expect(fresh.status).toBe(304)
    expect(fresh.headers).toEqual({
      etag: br,
      'last-modified': page.identity.headers['last-modified'],
      vary: 'Accept-Encoding',
    })
    expect(fresh.cacheControl).toBe('public, no-cache')
    expect(fresh.body).toBe(undefined)
    expect(stale.status).toBe(200)
    stale.body?.destroy()
  })

  // Ranges are offsets into the identity: a client that resumes a download asks for the bytes it already has.
  it('serves a range of the identity, even to a client that accepts brotli', async () => {
    const decision = await serveFile(page, request({ 'accept-encoding': 'br', range: 'bytes=0-14' }), ROUTE)

    expect(decision.status).toBe(206)
    expect(decision.headers['content-encoding']).toBe(undefined)
    expect(decision.headers['content-range']).toBe(`bytes 0-14/${page.identity.size}`)
    expect(decision.headers['content-length']).toBe('15')
    expect(await text(decision.body)).toBe('<!doctype html>')
  })

  it('ignores Range, and negotiates, for a client that refuses identity', async () => {
    const decision = await serveFile(
      page,
      request({ 'accept-encoding': 'identity;q=0, br', range: 'bytes=0-14' }),
      ROUTE,
    )

    expect(decision.status).toBe(200)
    expect(decision.headers['content-encoding']).toBe('br')
    decision.body?.destroy()
  })

  it('takes If-Range with the strong tag of the identity, and serves the whole file for a weak one', async () => {
    const etag = page.identity.headers.etag!

    const held = await serveFile(page, request({ range: 'bytes=0-0', 'if-range': etag }), ROUTE)
    const weak = await serveFile(page, request({ range: 'bytes=0-0', 'if-range': `W/${etag}` }), ROUTE)

    expect(held.status).toBe(206)
    expect(weak.status).toBe(200)
    held.body?.destroy()
    weak.body?.destroy()
  })

  // A client asks for one range; serving several would mean a multipart body for a rare request.
  it('serves the whole file for several ranges', async () => {
    const decision = await serveFile(page, request({ range: 'bytes=0-1, 4-5' }), ROUTE)

    expect(decision.status).toBe(200)
    expect(decision.headers['content-length']).toBe(String(page.identity.size))
    decision.body?.destroy()
  })

  // A 416 must not carry the file's type, length or year-long Cache-Control: it is not the file.
  it('answers 416 with Content-Range alone', async () => {
    const decision = await serveFile(page, request({ range: `bytes=${page.identity.size}-` }), ROUTE)

    expect(decision).toEqual({
      status: 416,
      headers: { 'content-range': `bytes */${page.identity.size}` },
      cacheControl: undefined,
      body: undefined,
    })
  })

  it('refuses a failed If-Match, and a client that accepts no representation', async () => {
    await expect(serveFile(page, request({ 'if-match': '"other"' }), ROUTE)).rejects.toThrow(ErrHTTPPreconditionFailed)
    await expect(serveFile(icon, request({ 'accept-encoding': 'identity;q=0' }), ROUTE)).rejects.toThrow(
      ErrHTTPNotAcceptable,
    )
  })

  it('applies neither preconditions nor ranges to an answer that is not in place of a 200', async () => {
    const decision = await serveFile(page, request({ range: 'bytes=0-0', 'if-match': '"other"' }), {
      via: 'sendFile',
      conditional: false,
      log: SILENT,
    })

    expect(decision.status).toBe(200)
    expect(decision.cacheControl).toBe('private, no-cache')
    decision.body?.destroy()
  })

  it('answers HEAD with the headers of the GET and no body', async () => {
    const decision = await serveFile(icon, request({}, 'HEAD'), ROUTE)

    expect(decision).toEqual({
      status: 200,
      headers: icon.identity.headers,
      cacheControl: 'public, no-cache',
      body: undefined,
    })
  })
})

describe('prepareFile', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'caffeine-serve-')))
    await cp(spa, join(root, 'site'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function refusal(path: string): Promise<string> {
    const site = join(root, 'site')
    const manifest = await readManifest(site)
    let err: unknown

    try {
      prepareFile(rootOnDisk(site), path, manifest.files[path]!, POLICY)
    } catch (caught) {
      err = caught
    }

    expect(err).toBeInstanceOf(ErrStaticManifest)

    return (err as Error).message.split('\n')[0]!.replace(`Cannot serve "${site}": `, '')
  }

  // A file edited after the build would be served under the old ETag and cut at the old length.
  it('refuses a file of another size than the manifest says', async () => {
    await writeFile(join(root, 'site/favicon.svg'), 'changed')

    expect(await refusal('favicon.svg')).toMatch(/^"favicon\.svg" is 7 bytes, and the manifest says \d+$/)
  })

  it('refuses a listed file that is gone', async () => {
    await unlink(join(root, 'site/favicon.svg'))

    expect(await refusal('favicon.svg')).toBe('"favicon.svg" is listed but missing')
  })

  it('refuses a symlink in place of a listed file', async () => {
    await unlink(join(root, 'site/favicon.svg'))
    await symlink(join(spa, 'favicon.svg'), join(root, 'site/favicon.svg'))

    expect(await refusal('favicon.svg')).toBe('"favicon.svg" is not a regular file')
  })

  it('refuses a file a symlinked directory moves out of the root', async () => {
    await rm(join(root, 'site/assets'), { recursive: true })
    await symlink(join(spa, 'assets'), join(root, 'site/assets'))

    expect(await refusal('assets/app-eZr2sdaR.js')).toBe('"assets/app-eZr2sdaR.js" resolves outside the root')
  })
})

describe('a file served by a route and by sendFile', () => {
  let site: string
  let app: WebApplication | undefined

  beforeEach(async () => {
    site = await mkdtemp(join(tmpdir(), 'caffeine-serve-app-'))
    await cp(spa, site, { recursive: true })
    await buildStatic({ root: site })
    app = createWebApplication({})
      .with(staticFiles(s => s.serve(site, { anonymous: true })))
      .mount(newRouter().get('/sent', ctx => sendFile(ctx, 'index.html'))) as WebApplication
    await app.bootstrap()
  })

  afterEach(async () => {
    await app?.close()
    await rm(site, { recursive: true, force: true })
  })

  // One engine: what differs is only whose gate decides the cache.
  it('answers with the same headers but Cache-Control', async () => {
    const headers = { 'accept-encoding': 'br' }
    const routed = await app!.request('/index.html', { headers })
    const sent = await app!.request('/sent', { headers })
    const strip = (res: Response) =>
      Object.fromEntries(
        [...res.headers].filter(([name]) => !['cache-control', 'date', 'connection', 'keep-alive'].includes(name)),
      )

    expect(strip(sent)).toEqual(strip(routed))
    expect(routed.headers.get('cache-control')).toBe('public, no-cache')
    expect(sent.headers.get('cache-control')).toBe('private, no-cache')
    expect(await sent.arrayBuffer()).toEqual(await routed.arrayBuffer())
  })

  // The headers are written only once the file is open, so a 500 carries none of the file's.
  it('answers 500 without the file headers for a file removed after start-up, and HEAD as before', async () => {
    const size = (await readFile(join(site, 'index.html'))).byteLength
    await unlink(join(site, 'index.html'))

    const get = await app!.request('/index.html')
    const head = await app!.request('/index.html', { method: 'HEAD' })

    expect(get.status).toBe(500)
    for (const name of ['content-encoding', 'etag', 'cache-control']) {
      expect(get.headers.get(name)).toBe(null)
    }
    // The problem details' own Vary, without the file's Accept-Encoding.
    expect(get.headers.get('vary')).toBe('Accept')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(size))
  })
})
