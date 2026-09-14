import { Readable } from 'node:stream'
import { createGzip, createBrotliCompress } from 'node:zlib'

import fastifyCompress from '@fastify/compress'
import fastify, { type FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { describe, it, expect } from 'vitest'

import {
  Encoding,
  encoding,
  Controller,
  Post,
  RouteBuilder,
  createWebApplication,
  fastifyAdapterFactory,
} from '../index.js'

function encodingApp() {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyCompress)
  }

  return createWebApplication(fastifyAdapterFactory(fastify()), {}).with(() => fp(plugin, { name: 'compress' }))
}

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

    const app = encodingApp().build()
    await app.ready()

    const payload = await brotli(JSON.stringify({ msg: 'hello' }))

    const res = await app.fetch('/encoding-single/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: payload,
    })

    expect(res.status).toBe(415)
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

    const app = encodingApp().build()
    await app.ready()

    const gzipPayload = await gzip(JSON.stringify({ msg: 'hello' }))
    const brotliPayload = await brotli(JSON.stringify({ msg: 'hello' }))

    const resGzip = await app.fetch('/encoding-multi/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipPayload,
    })

    const resBrotli = await app.fetch('/encoding-multi/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: brotliPayload,
    })

    expect(resGzip.status).toBe(200)
    expect(resBrotli.status).toBe(200)
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

    const app = encodingApp().build()
    await app.ready()

    const payload = await brotli(JSON.stringify({ msg: 'hello' }))

    const resA = await app.fetch('/encoding-class/a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: payload,
    })

    const resB = await app.fetch('/encoding-class/b', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'br' },
      body: payload,
    })

    expect(resA.status).toBe(415)
    expect(resB.status).toBe(415)
  })

  describe('encoding() extension', () => {
    it('writes the same spec as an equivalent options.decompress assignment', () => {
      const viaExtension = new RouteBuilder()
      encoding('gzip')(viaExtension)

      const viaOptions = new RouteBuilder()
      viaOptions.options('decompress', { requestEncodings: ['gzip'] })

      expect(viaExtension.toRoute().options).toEqual(viaOptions.toRoute().options)
    })
  })
})
