import { describe, expect, it } from 'vitest'

import { RouteBuilder } from '../core/routing/builder.js'
import { BodyAsBuffer, bodyAsBuffer } from './body_as_buffer.js'
import { BodyAsStream, bodyAsStream } from './body_as_stream.js'
import { Controller } from './controller.js'
import { MultipartBodyInput, multipartBody } from './multipart_body.js'
import { getRouteGroup } from './registrar/registrar.js'
import { Post } from './verbs.js'

describe('multipart route declarations', () => {
  it('declares form-data by default and preserves a controller method’s inputs and resulting media type', () => {
    @Controller('/bundles')
    class Bundles {
      @MultipartBodyInput()
      @Post('/')
      upload(): void {}

      @MultipartBodyInput('RELATED', { maxParts: 3 })
      @Post('/related')
      related(): void {}
    }

    const routes = getRouteGroup(Bundles)!.toRouteGroup().routes
    expect(routes.map(route => [route.accept, route.multipart])).toEqual([
      [['multipart/form-data'], { subtype: 'form-data' }],
      [['multipart/related'], { subtype: 'related', limits: { maxParts: 3 } }],
    ])
  })

  it('snapshots limits, normalizes a subtype and publishes equivalent media declarations once', () => {
    const limits = { maxParts: 3 }
    const builder = new RouteBuilder().consumes('MULTIPART/RELATED')
    multipartBody('Related', limits)(builder)
    const route = builder.consumes('multipart/related').toRoute()
    limits.maxParts = 5

    expect(route.multipart).toEqual({ subtype: 'related', limits: { maxParts: 3 } })
    expect(route.accept).toEqual(['multipart/related'])
  })

  it('admits any multipart subtype only for the explicit wildcard', () => {
    const builder = new RouteBuilder()
    multipartBody('*')(builder)
    expect(builder.toRoute().accept).toEqual(['multipart/*'])
  })

  it('reports invalid limit overrides as a route configuration error', () => {
    const builder = new RouteBuilder()
    multipartBody('form-data', { maxParts: 0 })(builder)

    expect(() => builder.toRoute()).toThrowError(
      expect.objectContaining({ code: 'ERR_CONFIGURATION', message: expect.stringContaining('maxParts') }),
    )
  })

  it.each(['form-data; charset=utf-8', 'multipart/mixed', 'mixed ', 'x\n', 'rélated', 'mi*ed', ''])(
    'refuses invalid subtype %j when building the route',
    subtype => {
      const builder = new RouteBuilder()
      multipartBody(subtype)(builder)
      expect(() => builder.toRoute()).toThrow(/A multipart subtype must be an ASCII token/)
    },
  )

  it('refuses contradictory consumes entries in either declaration order', () => {
    const before = new RouteBuilder().consumes('application/json')
    multipartBody()(before)
    const after = new RouteBuilder()
    multipartBody()(after)
    after.consumes('multipart/related')
    for (const builder of [before, after]) {
      expect(() => builder.toRoute()).toThrow(/consumes declarations disagree/)
    }
  })

  it('refuses competing multipart declarations and either order of raw and multipart extensions', () => {
    const multipart = multipartBody()
    for (const other of [multipartBody('mixed'), bodyAsStream(), bodyAsBuffer()]) {
      for (const extensions of [
        [multipart, other],
        [other, multipart],
      ]) {
        const builder = new RouteBuilder().name('receive')
        for (const extend of extensions) {
          extend(builder)
        }
        expect(() => builder.toRoute()).toThrow(/route "receive".*multiple body readers/)
      }
    }
  })

  it('refuses competing decorators at route build in either order', () => {
    @Controller('/buffer')
    class BufferUpload {
      @MultipartBodyInput()
      @BodyAsBuffer()
      @Post('/')
      upload(): void {}
    }

    @Controller('/stream')
    class StreamUpload {
      @BodyAsStream()
      @MultipartBodyInput()
      @Post('/')
      upload(): void {}
    }

    for (const controller of [BufferUpload, StreamUpload]) {
      expect(() => getRouteGroup(controller)!.toRouteGroup()).toThrow(/route "upload".*multiple body readers/)
    }
  })
})
