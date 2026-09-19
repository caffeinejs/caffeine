import { $t } from '@caffeinejs/std'
import {
  InlineConfigSource,
  loadConfig,
  type ConfigSchema,
  type ConfigView,
  type LiveConfig,
} from '@caffeinejs/std/config'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

// What a configuration read costs on a request path: three property levels, `app.server.port`.
//
// Two controls bound every result. A plain frozen object is the floor. The leanest Proxy that could still serve
// live values (one trap, one field load, no cache) is the floor for anything built on a Proxy, which the
// configuration no longer is.
//
// Each case runs twice: at a monomorphic call site, fed one object, and at a megamorphic one, fed eight objects of
// different shapes in turn, which is what a read inside shared framework code sees.
//
// A live node that repeats a key list another node already took, `app.replica` beside `app.server` or any node of
// a second store, is read on its own too. A live object whose nodes cannot share a hidden class falls into
// dictionary mode there, and only these cases show it.
//
// So is a snapshot whose schema dropped undeclared keys. Validation deletes them, and V8 keeps an object it deleted
// a key from in dictionary mode unless the store hands out a copy.

interface Server {
  host: string
  port: number
}

interface Tree {
  app: { server: Server; replica: Server }
}

const SHAPES = 8

// Every level carries a key of its own ahead of the ones read, so no two trees share a hidden class at any level.
// Within one tree, `replica` repeats the keys of `server`.
function makeTree(i: number): Tree {
  return {
    [`x${i}`]: i,
    app: {
      [`y${i}`]: i,
      server: { [`z${i}`]: i, host: '0.0.0.0', port: 3000 + i },
      replica: { [`z${i}`]: i, host: '0.0.0.0', port: 4000 + i },
    },
  } as unknown as Tree
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      freezeDeep((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

interface ProxyState {
  current: Record<PropertyKey, unknown>
  children: Record<PropertyKey, unknown>
}

// Children are built once, so a read allocates nothing: one trap and one or two field loads per level.
function minimalProxy(node: object): unknown {
  const children: Record<PropertyKey, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      children[key] = minimalProxy(value as object)
    }
  }
  const state: ProxyState = { current: node as Record<PropertyKey, unknown>, children }
  return new Proxy(state, { get: (target, prop) => target.children[prop] ?? target.current[prop] })
}

async function configOf(tree: Tree): Promise<{ live: LiveConfig<Tree>; snapshot: Tree; view: ConfigView<Server> }> {
  const store = await loadConfig<Tree>(
    {
      schema: { '~standard': { version: 1, vendor: 'bench', validate: value => ({ value: value as Tree }) } },
      key: undefined,
      storeKey: undefined,
      sources: [new InlineConfigSource(tree as unknown as Record<string, unknown>)],
      loadTimeoutMs: 30_000,
    },
    { start: false },
  )

  return {
    live: store.live,
    snapshot: store.current as Tree,
    view: store.view(c => c.app.server) as ConfigView<Server>,
  }
}

const trees = Array.from({ length: SHAPES }, (_, i) => freezeDeep(makeTree(i)))
const plains = trees
const proxies = trees.map(tree => minimalProxy(tree) as Tree)
const loaded = await Promise.all(trees.map(configOf))
const lives = loaded.map(l => l.live)
const snapshots = loaded.map(l => l.snapshot)
const views = loaded.map(l => l.view)
const secondStore = (await configOf(trees[0])).live

// Declares the read path only, so `x0`, `y0` and `z0` are dropped at every level.
const serverSchema = $t.Object({ host: $t.String(), port: $t.Number() })
const cleaned = await loadConfig<Tree>(
  {
    schema: $t.Object({ app: $t.Object({ server: serverSchema, replica: serverSchema }) }) as ConfigSchema<Tree>,
    key: undefined,
    storeKey: undefined,
    sources: [new InlineConfigSource(trees[0] as unknown as Record<string, unknown>)],
    loadTimeoutMs: 30_000,
  },
  { start: false },
)
const droppedSnapshot = cleaned.current as Tree

// One function per case and per call site, so no two benchmarks share an inline cache.
const plainMono = (c: Tree): number => c.app.server.port
const plainMega = (c: Tree): number => c.app.server.port
const proxyMono = (c: Tree): number => c.app.server.port
const proxyMega = (c: Tree): number => c.app.server.port
const liveMono = (c: LiveConfig<Tree>): number => c.app.server.port
const liveMega = (c: LiveConfig<Tree>): number => c.app.server.port
const liveReplicaMono = (c: LiveConfig<Tree>): number => c.app.replica.port
const liveReplicaMega = (c: LiveConfig<Tree>): number => c.app.replica.port
const liveSecondStoreMono = (c: LiveConfig<Tree>): number => c.app.server.port
const snapshotMono = (c: Tree): number => c.app.server.port
const snapshotMega = (c: Tree): number => c.app.server.port
const snapshotDroppedMono = (c: Tree): number => c.app.server.port
const viewMono = (v: ConfigView<Server>): number => v.value.port
const viewMega = (v: ConfigView<Server>): number => v.value.port

let i = 0
const next = (): number => (i = (i + 1) & (SHAPES - 1))

group('monomorphic: c.app.server.port', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMono(plains[0])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMono(proxies[0])))
    bench('live config object', () => do_not_optimize(liveMono(lives[0])))
    bench('live config object, node repeating a sibling: c.app.replica.port', () =>
      do_not_optimize(liveReplicaMono(lives[0])))
    bench('live config object, second store of one shape', () => do_not_optimize(liveSecondStoreMono(secondStore)))
    bench('snapshot (store.current, ctx.config)', () => do_not_optimize(snapshotMono(snapshots[0])))
    bench('snapshot, after the schema dropped undeclared keys', () =>
      do_not_optimize(snapshotDroppedMono(droppedSnapshot)))
    bench('view over app.server: v.value.port', () => do_not_optimize(viewMono(views[0])))
  })
})

group('megamorphic: c.app.server.port over 8 shapes', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMega(plains[next()])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMega(proxies[next()])))
    bench('live config object', () => do_not_optimize(liveMega(lives[next()])))
    bench('live config object, nodes repeating a sibling: c.app.replica.port', () =>
      do_not_optimize(liveReplicaMega(lives[next()])))
    bench('snapshot (store.current, ctx.config)', () => do_not_optimize(snapshotMega(snapshots[next()])))
    bench('view over app.server: v.value.port', () => do_not_optimize(viewMega(views[next()])))
  })
})

await run()
