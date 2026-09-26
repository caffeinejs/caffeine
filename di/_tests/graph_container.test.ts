import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import {
  buildBindingGraph,
  graphToMarkdown,
  graphToMermaid,
  graphToDot,
  graphToJSON,
  graphToText,
  type BindingGraph,
} from '../graph/index.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { Scopes } from '../scope.js'

class ServiceB {}
class ServiceC {}
class ServiceA {
  constructor(
    readonly b: ServiceB,
    readonly c: ServiceC,
  ) {}
}
class ServiceD {
  constructor(readonly a: ServiceA) {}
}

describe('graph functions with container as iterable', function () {
  it('buildBindingGraph includes user-registered bindings', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA, t => t.toClass(ServiceA, [ServiceB, ServiceC]))
    di.bind(ServiceB, t => t.toSelf())
    di.bind(ServiceC, t => t.toSelf())

    const graph = buildBindingGraph(di)
    const labels = graph.nodes.map(n => n.label)

    expect(labels).toContain('ServiceA')
    expect(labels).toContain('ServiceB')
    expect(labels).toContain('ServiceC')
  })

  it('graphToText shows node label and scope for single binding', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceB, t => t.toSelf().lifetime(Scopes.TRANSIENT))

    const output = graphToText(di)

    expect(output).toContain('ServiceB')
    expect(output).toContain('transient')
  })

  it('graphToMarkdown shows injection edge when dependency registered', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceD, t => t.toClass(ServiceD, [ServiceA]))
    di.bind(ServiceA, t => t.toClass(ServiceA, [ServiceB, ServiceC]))
    di.bind(ServiceB, t => t.toSelf())
    di.bind(ServiceC, t => t.toSelf())

    const output = graphToMarkdown(di)

    expect(output).toContain('## Dependencies')
    expect(output).toContain('- ServiceD')
    expect(output).toContain('  - ServiceA')
    expect(output).toContain('- ServiceA')
    expect(output).toContain('  - ServiceB')
    expect(output).toContain('  - ServiceC')
  })

  it('graphToMermaid shows named-group edge for shared qualifier', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA, t => t.toClass(ServiceA, [ServiceB, ServiceC]).names('handler'))
    di.bind(ServiceB, t => t.toSelf().names('handler'))
    di.bind(ServiceC, t => t.toSelf())

    const output = graphToMermaid(di)

    expect(output).toContain('flowchart LR')
    expect(output).toContain('-.->')
    expect(output).toContain('handler')
  })

  it('graphToDot marks primary binding', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceB, t => t.toSelf().primary())

    const output = graphToDot(di)

    expect(output).toContain('digraph bindings')
    expect(output).toContain('[primary]')
    expect(output).toContain('ServiceB')
  })

  it('graphToJSON serializes injection edges from container', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA, t => t.toClass(ServiceA, [ServiceB, ServiceC]))
    di.bind(ServiceB, t => t.toSelf())
    di.bind(ServiceC, t => t.toSelf())

    const parsed = JSON.parse(graphToJSON(di))
    const labels = parsed.nodes.map((n: { label: string }) => n.label)

    expect(labels).toContain('ServiceA')
    expect(labels).toContain('ServiceB')
    expect(labels).toContain('ServiceC')

    const injEdges = parsed.edges.filter((e: { kind: string }) => e.kind === 'injection')
    expect(injEdges).toHaveLength(2)
    expect(injEdges[0].meta).toBe('param[0]')
    expect(injEdges[1].meta).toBe('param[1]')
  })

  it('container Symbol.iterator and entries() produce same graph', function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(ServiceA, t => t.toClass(ServiceA, [ServiceB, ServiceC]))
    di.bind(ServiceB, t => t.toSelf())
    di.bind(ServiceC, t => t.toSelf())

    const fromIterator = buildBindingGraph(di)
    const fromEntries = buildBindingGraph(di.entries())

    expect(fromIterator.nodes.map(n => n.id)).toEqual(fromEntries.nodes.map(n => n.id))
    expect(fromIterator.edges).toHaveLength(fromEntries.edges.length)
  })
})

// A graph is read to learn what depends on what, so an edge has to mean "this binding is injected there". An edge
// must not be missing for a dependency the container wires, and must not point at a candidate it does not pick.
describe('edges follow what resolution injects', function () {
  function edgesFrom(graph: BindingGraph, label: string): { to: string | undefined; meta: string | undefined }[] {
    const labelOf = new Map(graph.nodes.map(n => [n.id, n.label]))
    const from = graph.nodes.find(n => n.label === label)!.id

    return graph.edges
      .filter(e => e.fromID === from && e.kind !== 'named-group' && e.kind !== 'label-group')
      .map(e => ({ to: labelOf.get(e.toID), meta: e.meta }))
  }

  it('follows a deferred injection', async function () {
    class DeferTarget {}

    class DeferHolder {
      constructor(readonly target: DeferTarget) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(DeferTarget, t => t.toSelf())
    di.bind(DeferHolder, t => t.toSelf([$i.defer(() => DeferTarget)]))
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'DeferHolder')).toEqual([{ to: 'DeferTarget', meta: 'param[0]' }])
  })

  it('follows every field of an object injection, nested ones included', async function () {
    class ObjRepo {}
    class ObjClock {}

    class ObjService {
      constructor(readonly deps: { repo: ObjRepo; bag: { clock: ObjClock }; obj: { clock: ObjClock } }) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(ObjRepo, t => t.toSelf())
    di.bind(ObjClock, t => t.toSelf())
    di.bind(ObjService, t =>
      t.toSelf([$i.object({ repo: ObjRepo, bag: { clock: ObjClock }, obj: $i.object({ clock: ObjClock }) })]),
    )
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'ObjService')).toEqual([
      { to: 'ObjRepo', meta: 'param[0].repo' },
      { to: 'ObjClock', meta: 'param[0].bag.clock' },
      { to: 'ObjClock', meta: 'param[0].obj.clock' },
    ])
  })

  describe('a base with several implementations', function () {
    abstract class Store {
      abstract kind(): string
    }

    class SqlStore extends Store {
      kind(): string {
        return 'sql'
      }
    }

    class MemStore extends Store {
      kind(): string {
        return 'mem'
      }
    }

    class StoreReader {
      constructor(readonly store: Store) {}
    }

    class StoreRegistry {
      constructor(readonly stores: Store[]) {}
    }

    async function container(): Promise<CaffeineIoC> {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(SqlStore, t => t.toSelf().extends(Store).primary())
      di.bind(MemStore, t => t.toSelf().extends(Store))
      di.bind(StoreReader, t => t.toSelf([Store]))
      di.bind(StoreRegistry, t => t.toSelf([$i.allOf(Store)]))
      await di.init()

      return di
    }

    it('points a single injection at the primary only', async function () {
      const graph = buildBindingGraph(await container())

      expect(edgesFrom(graph, 'StoreReader')).toEqual([{ to: 'SqlStore', meta: 'param[0]' }])
    })

    it('points a collecting injection at every implementation, labelled with the key it asked for', async function () {
      const di = await container()

      expect(edgesFrom(buildBindingGraph(di), 'StoreRegistry')).toEqual([
        { to: 'SqlStore', meta: 'param[0]' },
        { to: 'MemStore', meta: 'param[0]' },
      ])
      expect(graphToText(di)).toContain('└─ Store')
    })
  })

  it('points a single injection of a name at its primary binding only', async function () {
    interface Db {
      url(): string
    }

    const kDb = token<Db>(Symbol('graph-primary-db'))

    class PrimaryDb implements Db {
      url(): string {
        return 'primary'
      }
    }

    class ReplicaDb implements Db {
      url(): string {
        return 'replica'
      }
    }

    class DbUser {
      constructor(readonly db: Db) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(PrimaryDb, t => t.toSelf().names(kDb).primary())
    di.bind(ReplicaDb, t => t.toSelf().names(kDb))
    di.bind(DbUser, t => t.toSelf([kDb]))
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'DbUser')).toEqual([{ to: 'PrimaryDb', meta: 'param[0]' }])
  })

  it('keeps two names apart even when their symbols share a description', async function () {
    interface Conn {
      id(): string
    }

    const kFirst = token<Conn>(Symbol('db'))
    const kSecond = token<Conn>(Symbol('db'))

    class FirstConn implements Conn {
      id(): string {
        return 'first'
      }
    }

    class SecondConn implements Conn {
      id(): string {
        return 'second'
      }
    }

    class ConnUser {
      constructor(readonly conn: Conn) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(FirstConn, t => t.toSelf().names(kFirst))
    di.bind(SecondConn, t => t.toSelf().names(kSecond))
    di.bind(ConnUser, t => t.toSelf([kFirst]))
    await di.init()

    const graph = buildBindingGraph(di)

    expect(edgesFrom(graph, 'ConnUser')).toEqual([{ to: 'FirstConn', meta: 'param[0]' }])
    expect(graph.edges.filter(e => e.kind === 'named-group')).toHaveLength(0)
  })

  it('keeps two label groups apart even when their symbols share a description', async function () {
    const kWebA = Symbol('web')
    const kWebB = Symbol('web')

    class WebOne {}
    class WebTwo {}
    class WebThree {}
    class WebFour {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(WebOne, t => t.toSelf().labels(kWebA))
    di.bind(WebTwo, t => t.toSelf().labels(kWebA))
    di.bind(WebThree, t => t.toSelf().labels(kWebB))
    di.bind(WebFour, t => t.toSelf().labels(kWebB))
    await di.init()

    const lines = graphToMarkdown(di)
      .split('\n')
      .filter(l => l.startsWith('- label `web`'))

    expect(lines).toEqual(['- label `web`: WebOne, WebTwo', '- label `web`: WebThree, WebFour'])
  })

  it('lists every binding sharing a name on one group line', async function () {
    class PrimaryDB {}
    class ReplicaDB {}
    class AnalyticsDB {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(PrimaryDB, t => t.toSelf().names('graph-db'))
    di.bind(ReplicaDB, t => t.toSelf().names('graph-db'))
    di.bind(AnalyticsDB, t => t.toSelf().names('graph-db'))
    await di.init()

    const lines = graphToMarkdown(di)
      .split('\n')
      .filter(l => l.startsWith('- qualifier `graph-db`'))

    expect(lines).toEqual(['- qualifier `graph-db`: PrimaryDB, ReplicaDB, AnalyticsDB'])
  })

  it('labels a site receiving several bindings with the key it asked for, not a name they share', async function () {
    interface Pool {
      size(): number
    }

    const kPrimaryPool = token<Pool>('graph-primary-pool')
    const kPool = token<Pool>('graph-pool')

    class PoolA implements Pool {
      size(): number {
        return 1
      }
    }

    class PoolB implements Pool {
      size(): number {
        return 2
      }
    }

    class PoolUser {
      constructor(readonly pools: Pool[]) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(PoolA, t => t.toSelf().names(kPrimaryPool, kPool))
    di.bind(PoolB, t => t.toSelf().names(kPrimaryPool, kPool))
    di.bind(PoolUser, t => t.toSelf([$i.allOf(kPool)]))
    await di.init()

    expect(graphToText(di)).toContain('└─ graph-pool')
    expect(graphToText(di)).not.toContain('└─ graph-primary-pool')
  })

  it('draws no edge from a collecting binding to itself', async function () {
    abstract class Plugin {}

    class SimplePlugin extends Plugin {}

    class CompositePlugin extends Plugin {
      constructor(readonly plugins: Plugin[]) {
        super()
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(SimplePlugin, t => t.toSelf().extends(Plugin))
    di.bind(CompositePlugin, t => t.toSelf([$i.allOf(Plugin)]).extends(Plugin))
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'CompositePlugin')).toEqual([{ to: 'SimplePlugin', meta: 'param[0]' }])
  })

  it('draws one edge to a binding registered under a key it is also named after', async function () {
    interface Cache {
      hit(): boolean
    }

    const kCache = token<Cache>('graph-cache')

    class RedisCache implements Cache {
      hit(): boolean {
        return true
      }
    }

    class CacheUser {
      constructor(readonly cache: Cache) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(kCache, t => t.toClass(RedisCache).names(kCache))
    di.bind(CacheUser, t => t.toSelf([kCache]))
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'CacheUser')).toEqual([{ to: 'graph-cache', meta: 'param[0]' }])
  })

  it('draws no edge for a configuration value, which is not a binding', async function () {
    class Server {
      constructor(readonly port: number) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Server, t => t.toSelf([$i.value('server.port', 8080)]))
    await di.init()

    expect(edgesFrom(buildBindingGraph(di), 'Server')).toEqual([])
  })
})
