import { describe, expect, it } from 'vitest'
import { Get } from '../decorators/verbs.js'
import { Controller } from '../decorators/controller.js'
import { getRouter } from '../decorators/registrar/registrar.js'

describe('HTTPAdapter', () => {
  it('should be defined', () => {
    @Controller('/test')
    class TestController {
      @Get('/')
      async get() {
        return { ok: true }
      }
    }

    void new TestController()
  })

  it('registrar subpath export shares the same registry as decorators', () => {
    @Controller('/registrar-export')
    class RegistrarExportController {
      @Get('/ping')
      ping() {
        return { ok: true }
      }
    }

    void RegistrarExportController

    expect(getRouter(RegistrarExportController)).toBeDefined()
  })
})

describe('path normalization', () => {
  it('strips trailing slash from prefix', () => {
    @Controller('/')
    class C1 {
      @Get('/action')
      get() { return {} }
    }
    void C1
    const r = getRouter(C1)!.toRouter()
    expect(r.path).toBe('')
    expect(r.routes[0].path).toBe('/action')
  })

  it('strips trailing slash from multi-segment prefix', () => {
    @Controller('/api/')
    class C2 {
      @Get('/users')
      get() { return {} }
    }
    void C2
    const r = getRouter(C2)!.toRouter()
    expect(r.path).toBe('/api')
    expect(r.routes[0].path).toBe('/users')
  })

  it('adds leading slash to path when missing', () => {
    @Controller('/api')
    class C3 {
      @Get('action')
      get() { return {} }
    }
    void C3
    const r = getRouter(C3)!.toRouter()
    expect(r.routes[0].path).toBe('/action')
  })

  it('collapses double slashes in path', () => {
    @Controller('/api')
    class C4 {
      @Get('//double')
      get() { return {} }
    }
    void C4
    const r = getRouter(C4)!.toRouter()
    expect(r.routes[0].path).toBe('/double')
  })

  it('preserves root path', () => {
    @Controller('')
    class C5 {
      @Get('/')
      get() { return {} }
    }
    void C5
    const r = getRouter(C5)!.toRouter()
    expect(r.path).toBe('')
    expect(r.routes[0].path).toBe('/')
  })

  it('safe concat: prefix "/" + path "/action" yields "/action"', () => {
    @Controller('/')
    class C6 {
      @Get('/action')
      go() { return {} }
    }
    void C6
    const r = getRouter(C6)!.toRouter()
    expect(`${r.path}${r.routes[0].path}`).toBe('/action')
  })
})
