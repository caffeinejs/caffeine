import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { ErrScopeMismatchInConfiguration } from '../../../errors.js'
import { Injectable } from '../injectable.js'
import { Configuration } from '../configuration.js'
import { Provides } from '../provides.js'
import { Lifetime } from '../lifetime.js'
import { Scopes } from '../../../scope.js'
import { Lazy } from '../lazy.js'
import { Async } from '../async.js'

describe('Legacy @Configuration + @Provides', function () {
  describe('basic @Provides', function () {
    class Conn {
      query() {
        return 'result'
      }
    }

    @Configuration()
    class AppConfig {
      @Provides(Conn)
      conn(): Conn {
        return new Conn()
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('provides bean from @Configuration method', function () {
      const conn = di.get(Conn)
      expect(conn)
        .toBeInstanceOf(Conn)
      expect(conn.query())
        .toBe('result')
    })
  })

  describe('@Provides with dependencies', function () {
    @Injectable()
    class Db {
      url = 'postgres://localhost'
    }

    class Pool {
      constructor(readonly db: Db) {}
    }

    @Configuration()
    class PoolConfig {
      @Provides(Pool, [Db])
      pool(db: Db): Pool {
        return new Pool(db)
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('injects deps into @Provides factory', function () {
      const pool = di.get(Pool)
      expect(pool)
        .toBeInstanceOf(Pool)
      expect(pool.db)
        .toBeInstanceOf(Db)
      expect(pool.db.url)
        .toBe('postgres://localhost')
    })
  })

  describe('@Provides with named key', function () {
    const KEY = 'legacy-config-named'

    @Configuration()
    class NamedConfig {
      @Provides(KEY)
      service(): string {
        return 'from-config'
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('provides by named key', function () {
      expect(di.get<string>(KEY))
        .toBe('from-config')
    })
  })

  describe('@Configuration singleton scope propagation', function () {
    class Svc {}

    @Lifetime(Scopes.SINGLETON)
    @Configuration()
    class ScopedConfig {
      @Provides(Svc)
      svc(): Svc {
        return new Svc()
      }
    }

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('singleton scope propagates to provided beans', function () {
      expect(di.get(Svc))
        .toBe(di.get(Svc))
    })
  })

  describe('@Async() + @Provides', function () {
    class AsyncClient {
      constructor(readonly status: string) {}
    }

    @Configuration()
    class AsyncClientConfig {
      @Async()
      @Provides(AsyncClient)
      async client(): Promise<AsyncClient> {
        return new AsyncClient('connected')
      }
    }

    void AsyncClientConfig

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('resolves async @Provides bean synchronously after init', function () {
      const client = di.get(AsyncClient)
      expect(client).toBeInstanceOf(AsyncClient)
      expect(client.status).toBe('connected')
    })

    it('binding is marked async', function () {
      expect(di.getBinding(AsyncClient).async).toBe(true)
    })
  })

  describe('@Provides with multiple methods', function () {
    class SvcA {
      name() {
        return 'A'
      }
    }

    class SvcB {
      name() {
        return 'B'
      }
    }

    @Configuration()
    class MultiConfig {
      @Provides(SvcA)
      svcA(): SvcA {
        return new SvcA()
      }

      @Provides(SvcB)
      svcB(): SvcB {
        return new SvcB()
      }
    }

    void MultiConfig

    const di = new DiCaf()

    beforeAll(async () => {
      await di.init()
    })

    it('provides all beans from multiple @Provides methods', function () {
      expect(di.get(SvcA).name()).toBe('A')
      expect(di.get(SvcB).name()).toBe('B')
    })
  })

  describe('error paths', function () {
    it('throws ErrScopeMismatchInConfiguration when @Configuration scope conflicts with @Provides scope', function () {
      expect(() => {
        class ScopeConflictSvc {}

        // @Lifetime(Scopes.SINGLETON) must be INNER (applied first) so classBinding.scopeId is set
        // before @Configuration() reads it and validates the member scopes
        @Configuration()
        @Lifetime(Scopes.SINGLETON)
        class ScopeConflictConf {
          @Lifetime(Scopes.TRANSIENT)
          @Provides(ScopeConflictSvc)
          svc(): ScopeConflictSvc {
            return new ScopeConflictSvc()
          }
        }

        void ScopeConflictConf
      }).toThrow(ErrScopeMismatchInConfiguration)
    })

    it('throws ErrInvalidDecorator when @Configuration method has no @Provides key', function () {
      expect(() => {
        @Configuration()
        class MissingKeyConf {
          @Lazy()
          noKey() {
            return {}
          }
        }

        void MissingKeyConf
      }).toThrow()
    })

    it('throws ErrInvalidDecorator when @Provides receives a null key', function () {
      expect(() => {
        @Configuration()
        class NullKeyConf {
          @Provides(null as any)
          nullBean() {
            return {}
          }
        }

        void NullKeyConf
      }).toThrow()
    })
  })
})
