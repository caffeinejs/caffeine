import { describe, expect, it } from 'vitest'
import { Get } from '../decorators/verbs.js'
import { Controller } from '../decorators/controller.js'
import { getRouteGroup } from '../decorators/registrar/registrar.js'

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

    expect(getRouteGroup(RegistrarExportController)).toBeDefined()
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
    const r = getRouteGroup(C1)!.toRouteGroup()
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
    const r = getRouteGroup(C2)!.toRouteGroup()
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
    const r = getRouteGroup(C3)!.toRouteGroup()
    expect(r.routes[0].path).toBe('/action')
  })

  it('collapses double slashes in path', () => {
    @Controller('/api')
    class C4 {
      @Get('//double')
      get() { return {} }
    }
    void C4
    const r = getRouteGroup(C4)!.toRouteGroup()
    expect(r.routes[0].path).toBe('/double')
  })

  it('preserves root path', () => {
    @Controller('')
    class C5 {
      @Get('/')
      get() { return {} }
    }
    void C5
    const r = getRouteGroup(C5)!.toRouteGroup()
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
    const r = getRouteGroup(C6)!.toRouteGroup()
    expect(`${r.path}${r.routes[0].path}`).toBe('/action')
  })
})
