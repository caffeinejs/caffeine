import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Post, Params, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { $p } from '../route_picker.js'

const FORM = 'application/x-www-form-urlencoded'

async function appWith(controller: unknown) {
  void [controller]
  const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
  await app.ready()
  return app
}

describe('form url-encoded body', () => {
  it('parses the fields into an object', async () => {
    @Controller('/form-object')
    class FormObjectController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormObjectController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-object/echo',
      payload: 'name=ada&age=36',
      headers: { 'content-type': FORM },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: 'ada', age: '36' })
  })

  it('collects a repeated key into an array', async () => {
    @Controller('/form-array')
    class FormArrayController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormArrayController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-array/echo',
      payload: 'tag=a&tag=b',
      headers: { 'content-type': FORM },
    })

    expect(res.json()).toEqual({ tag: ['a', 'b'] })
  })

  it('percent- and plus-decodes values', async () => {
    @Controller('/form-decode')
    class FormDecodeController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormDecodeController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-decode/echo',
      payload: 'msg=hello+world%21',
      headers: { 'content-type': FORM },
    })

    expect(res.json()).toEqual({ msg: 'hello world!' })
  })

  it('parses when the content-type carries a charset parameter', async () => {
    @Controller('/form-charset')
    class FormCharsetController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormCharsetController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-charset/echo',
      payload: 'name=ada',
      headers: { 'content-type': `${FORM}; charset=utf-8` },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: 'ada' })
  })

  it('does not pollute Object.prototype via a __proto__ field', async () => {
    @Controller('/form-proto')
    class FormProtoController {
      @Post('/echo')
      @Params([$p.body()])
      echo(_b: Record<string, unknown>) {
        return { polluted: ({} as Record<string, unknown>).polluted ?? null }
      }
    }

    const app = await appWith(FormProtoController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-proto/echo',
      payload: '__proto__[polluted]=yes&__proto__=yes',
      headers: { 'content-type': FORM },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ polluted: null })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('parses an empty body as an empty object', async () => {
    @Controller('/form-empty')
    class FormEmptyController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormEmptyController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-empty/echo',
      payload: '',
      headers: { 'content-type': FORM },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
  })

  it('treats a key with no equals as an empty string', async () => {
    @Controller('/form-bare-key')
    class FormBareKeyController {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(FormBareKeyController)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-bare-key/echo',
      payload: 'ok',
      headers: { 'content-type': FORM },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: '' })
  })

  it('no longer answers 415 for an urlencoded body', async () => {
    @Controller('/form-415')
    class Form415Controller {
      @Post('/echo')
      @Params([$p.body()])
      echo(b: Record<string, unknown>) {
        return b
      }
    }

    const app = await appWith(Form415Controller)
    const res = await app.instance.inject({
      method: 'POST',
      url: '/form-415/echo',
      payload: 'ok=1',
      headers: { 'content-type': FORM },
    })

    expect(res.statusCode).not.toBe(415)
    expect(res.statusCode).toBe(200)
  })
})
