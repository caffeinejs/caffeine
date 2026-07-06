import { createGzip, createBrotliCompress } from 'node:zlib'
import { Readable } from 'node:stream'
import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import compress from '@fastify/compress'
import { Controller, Post, createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory, Encoding } from '../index.js'

async function gzip(data: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  const gz = createGzip()
  gz.end(Buffer.from(data))
  for await (const chunk of gz) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function brotli(data: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  const br = createBrotliCompress()
  br.end(Buffer.from(data))
  for await (const chunk of Readable.from(br)) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

describe('Encoding', () => {
  it('@Encoding("gzip") rejects a request compressed with br (415)', async () => {
    @Controller('/encoding-single')
    class SingleEncodingController {
      @Encoding('gzip')
      @Post('/upload')
      upload() {
        return { ok: true }
      }
    }

    void [SingleEncodingController]

    const server = fastify()
    await server.register(compress, { global: true })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const payload = await brotli(JSON.stringify({ msg: 'hello' }))

    const res = await server.inject({
      method: 'POST',
      url: '/encoding-single/upload',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload,
    })

    expect(res.statusCode).toBe(415)
  })

  it('@Encoding(["gzip", "br"]) accepts both gzip and br encoded requests', async () => {
    @Controller('/encoding-multi')
    class MultiEncodingController {
      @Encoding(['gzip', 'br'])
      @Post('/upload')
      upload() {
        return { ok: true }
      }
    }

    void [MultiEncodingController]

    const server = fastify()
    await server.register(compress, { global: true })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const gzipPayload = await gzip(JSON.stringify({ msg: 'hello' }))
    const brotliPayload = await brotli(JSON.stringify({ msg: 'hello' }))

    const resGzip = await server.inject({
      method: 'POST',
      url: '/encoding-multi/upload',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipPayload,
    })

    const resBrotli = await server.inject({
      method: 'POST',
      url: '/encoding-multi/upload',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload: brotliPayload,
    })

    expect(resGzip.statusCode).toBe(200)
    expect(resBrotli.statusCode).toBe(200)
  })

  it('class-level @Encoding applies to all routes on the controller', async () => {
    @Encoding('gzip')
    @Controller('/encoding-class')
    class ClassEncodingController {
      @Post('/a')
      a() {
        return { ok: true }
      }

      @Post('/b')
      b() {
        return { ok: true }
      }
    }

    void [ClassEncodingController]

    const server = fastify()
    await server.register(compress, { global: true })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const payload = await brotli(JSON.stringify({ msg: 'hello' }))

    const resA = await server.inject({
      method: 'POST',
      url: '/encoding-class/a',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload,
    })

    const resB = await server.inject({
      method: 'POST',
      url: '/encoding-class/b',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      payload,
    })

    expect(resA.statusCode).toBe(415)
    expect(resB.statusCode).toBe(415)
  })
})
