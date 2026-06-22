import assert from 'node:assert/strict'
import { DiCaf } from '@caffeine-projects/dicaf'
import { Configuration, Injectable, Provides } from '@caffeine-projects/dicaf/decorators'

Deno.test('public API exposes the core symbols', () => {
  assert.equal(typeof DiCaf, 'function')
  assert.equal(typeof Injectable, 'function')
  assert.equal(typeof Configuration, 'function')
  assert.equal(typeof Provides, 'function')
})

Deno.test('resolves a constructor-injected dependency graph', async () => {
  @Injectable()
  class Repo {
    list(): string {
      return 'listed'
    }
  }

  @Injectable([Repo])
  class Service {
    constructor(readonly repo: Repo) {}

    run(): string {
      return `service-${this.repo.list()}`
    }
  }

  @Injectable([Repo, Service])
  class Root {
    constructor(
      readonly repo: Repo,
      readonly service: Service,
    ) {}
  }

  const di = new DiCaf()
  await di.init()
  const root = di.get(Root)

  assert.ok(root instanceof Root)
  assert.ok(root.repo instanceof Repo)
  assert.ok(root.service instanceof Service)
  assert.equal(root.service.run(), 'service-listed')
  assert.strictEqual(root.repo, root.service.repo)
})

Deno.test('resolves a @Configuration @Provides factory bean', async () => {
  class Connection {
    constructor(readonly url: string) {}
  }

  @Configuration()
  class AppConfig {
    @Provides(Connection)
    connection(): Connection {
      return new Connection('deno://local')
    }
  }

  const di = new DiCaf()
  await di.init()
  const connection = di.get(Connection)

  assert.ok(connection instanceof Connection)
  assert.equal(connection.url, 'deno://local')
  assert.ok(AppConfig)
})
