import { InlineConfigSource, loadConfig, type ConfigView, type LiveConfig } from '@caffeinejs/std/config'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

// What a configuration read costs on a request path: three property levels, `app.server.port`.
//
// Two controls bound every result. A plain frozen object is the floor. The leanest Proxy that could still serve
// live values (one trap, one field load, no cache) is the floor for anything built on a Proxy, which the
// configuration no longer is.
//
// Each case runs twice: at a monomorphic call site, fed one object, and at a megamorphic one, fed eight objects of
// different shapes in turn, which is what a read inside shared framework code sees.

interface Tree {
  app: { server: { host: string; port: number } }
}

type Server = Tree['app']['server']

const SHAPES = 8

// Every level carries a key of its own ahead of the ones read, so no two trees share a hidden class at any level.
function makeTree(i: number): Tree {
  return {
    [`x${i}`]: i,
    app: {
      [`y${i}`]: i,
      server: { [`z${i}`]: i, host: '0.0.0.0', port: 3000 + i },
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

// One function per case and per call site, so no two benchmarks share an inline cache.
const plainMono = (c: Tree): number => c.app.server.port
const plainMega = (c: Tree): number => c.app.server.port
const proxyMono = (c: Tree): number => c.app.server.port
const proxyMega = (c: Tree): number => c.app.server.port
const liveMono = (c: LiveConfig<Tree>): number => c.app.server.port
const liveMega = (c: LiveConfig<Tree>): number => c.app.server.port
const snapshotMono = (c: Tree): number => c.app.server.port
const snapshotMega = (c: Tree): number => c.app.server.port
const viewMono = (v: ConfigView<Server>): number => v.value.port
const viewMega = (v: ConfigView<Server>): number => v.value.port

let i = 0
const next = (): number => (i = (i + 1) & (SHAPES - 1))

group('monomorphic: c.app.server.port', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMono(plains[0])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMono(proxies[0])))
    bench('live config object', () => do_not_optimize(liveMono(lives[0])))
    bench('snapshot (store.current, ctx.config)', () => do_not_optimize(snapshotMono(snapshots[0])))
    bench('view over app.server: v.value.port', () => do_not_optimize(viewMono(views[0])))
  })
})

group('megamorphic: c.app.server.port over 8 shapes', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMega(plains[next()])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMega(proxies[next()])))
    bench('live config object', () => do_not_optimize(liveMega(lives[next()])))
    bench('snapshot (store.current, ctx.config)', () => do_not_optimize(snapshotMega(snapshots[next()])))
    bench('view over app.server: v.value.port', () => do_not_optimize(viewMega(views[next()])))
  })
})

await run()
