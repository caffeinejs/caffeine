import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  type ConfigHandle,
  Configuration,
  ConfigDefinition,
  ConfigModule,
  InlineConfigProvider,
} from '@caffeinejs/std/config'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

// What a configuration read costs on a request path: three property levels, `app.server.port`.
//
// Two controls bound every result. A plain frozen object is the floor. The leanest Proxy that could still serve
// live values (one trap, one field load, no cache) is the floor for anything built on a Proxy.
//
// Each case runs twice: at a monomorphic call site, fed one object, and at a megamorphic one, fed eight objects of
// different shapes in turn, which is what a read inside shared framework code sees.

interface Tree {
  app: { server: { host: string; port: number } }
}

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

async function handles(tree: Tree): Promise<{ live: ConfigHandle<Tree>; snapshot: ConfigHandle<Tree> }> {
  const key = token<ConfigHandle<Tree>>(Symbol('bench.config'))
  const definition = new ConfigDefinition(key)
  definition.sources.add(new InlineConfigProvider(tree as never))

  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()

  return {
    live: container.get(key),
    snapshot: container.get(Configuration).snapshotHandle as ConfigHandle<Tree>,
  }
}

const trees = Array.from({ length: SHAPES }, (_, i) => freezeDeep(makeTree(i)))
const plains = trees
const proxies = trees.map(tree => minimalProxy(tree) as Tree)
const built = await Promise.all(trees.map(handles))
const lives = built.map(b => b.live)
const snapshots = built.map(b => b.snapshot)

// One function per case and per call site, so no two benchmarks share an inline cache.
const plainMono = (c: Tree): number => c.app.server.port
const plainMega = (c: Tree): number => c.app.server.port
const proxyMono = (c: Tree): number => c.app.server.port
const proxyMega = (c: Tree): number => c.app.server.port
const liveMono = (c: ConfigHandle<Tree>): number => c.app.server.port
const liveMega = (c: ConfigHandle<Tree>): number => c.app.server.port
const snapshotMono = (c: ConfigHandle<Tree>): number => c.app.server.port
const snapshotMega = (c: ConfigHandle<Tree>): number => c.app.server.port

let i = 0
const next = (): number => (i = (i + 1) & (SHAPES - 1))

group('monomorphic: c.app.server.port', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMono(plains[0])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMono(proxies[0])))
    bench('today: live handle', () => do_not_optimize(liveMono(lives[0])))
    bench('today: snapshot handle (ctx.config)', () => do_not_optimize(snapshotMono(snapshots[0])))
  })
})

group('megamorphic: c.app.server.port over 8 shapes', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMega(plains[next()])))
    bench('control: minimal Proxy', () => do_not_optimize(proxyMega(proxies[next()])))
    bench('today: live handle', () => do_not_optimize(liveMega(lives[next()])))
    bench('today: snapshot handle (ctx.config)', () => do_not_optimize(snapshotMega(snapshots[next()])))
  })
})

await run()
