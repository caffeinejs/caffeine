import Http, { IncomingMessage, ServerResponse } from 'http'
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest'
import Supertest from 'supertest'
import { randomUUID } from 'node:crypto'
import { DiCaf, Scopes } from '../../../index.nodejs.js'
import { Injectable } from '../../../decorators/injectable.js'
import { Lazy } from '../../../decorators/lazy.js'
import { Lifetime } from '../../../decorators/lifetime.js'
import { PostConstruct } from '../../../decorators/post_construct.js'
import { PreDestroy } from '../../../decorators/pre_destroy.js'

describe('Request Scope', function () {
  describe('common cases', function () {
    const ctorSpy = vi.fn()
    const initSpy = vi.fn()
    const destroySpy = vi.fn()
    const singletonSpy = vi.fn()

    @Injectable()
    @Lifetime(Scopes.REQUEST)
    class Ctrl {
      readonly id: string = randomUUID()

      constructor() {
        ctorSpy()
      }

      value() {
        return 'hello world'
      }

      @PostConstruct()
      init() {
        initSpy()
      }

      @PreDestroy()
      dispose() {
        destroySpy()
      }
    }

    @Injectable([Ctrl])
    @Lazy()
    class SingletonWithReq {
      constructor(readonly req: Ctrl) {
        singletonSpy()
      }
    }

    const di = new DiCaf({ checks: { scopes: 'off' } })

    beforeAll(async () => {
      await di.init()
    })

    async function requestListener(req: IncomingMessage, res: ServerResponse) {
      di.requestScopeManager.run(() => {
        const ctrl = di.get(Ctrl)

        res.writeHead(200)
        res.end(ctrl.value())
      })
    }

    const server = Http.createServer(requestListener)

    afterAll(async () => {
      server.close()

      await di.dispose()
    })

    beforeEach(() => {
      ctorSpy.mockReset()
      singletonSpy.mockReset()
      initSpy.mockReset()
      destroySpy.mockReset()
    })

    it('should fail when trying to resolve outside a request scope', function () {
      expect(() => di.get(Ctrl))
        .toThrow()
    })

    it('should fail when starting a nested request scope', async function () {
      await di.requestScopeManager.run(async () => {
        expect(() => di.requestScopeManager.run(() => {}))
          .toThrow()
      })
    })

    it('should destroy request-scoped instances when async run() rejects', async function () {
      await expect(
        di.requestScopeManager.run(async () => {
          di.get(Ctrl)
          throw new Error('request failed')
        }),
      ).rejects.toThrow('request failed')

      expect(destroySpy)
        .toHaveBeenCalledTimes(1)
    })

    describe('non request scoped with a request scope dependency', function () {
      it('should fail to resolve root component when not inside a request scope', function () {
        expect(() => di.get(SingletonWithReq))
          .toThrow()
      })
    })

    describe('when performing http requests', function () {
      it('should create and destroy one instance per request', async function () {
        const val = 'hello world'

        expect(() => di.get(Ctrl))
          .toThrow()

        await Supertest(server)
          .get('/')
          .expect(200)
          .expect(res => expect(res.text)
            .toEqual(val))

        await Supertest(server)
          .get('/')
          .expect(200)
          .expect(res => expect(res.text)
            .toEqual(val))

        expect(ctorSpy)
          .toHaveBeenCalledTimes(2)
        expect(initSpy)
          .toHaveBeenCalledTimes(2)
        expect(destroySpy)
          .toHaveBeenCalledTimes(2)

        expect(() => di.get(Ctrl))
          .toThrow()
      })
    })
  })
})
