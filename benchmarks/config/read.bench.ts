import { loadConfig, type ConfigSchema } from '@caffeinejs/std/config'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import { bench, do_not_optimize, group, run, summary } from 'mitata'

// What a configuration read costs on a request path: three property levels, `app.server.port`.
//
// A plain frozen object is the floor. A snapshot (`store.current`, `ctx.config`, the config token) should match it.
// The live token is a provider: `get()` hands back the current snapshot, so it should cost one call more and
// nothing else.
//
// Each case runs twice: at a monomorphic call site, fed one object, and at a megamorphic one, fed eight objects of
// different shapes in turn, which is what a read inside shared framework code sees.
//
// A snapshot whose schema dropped undeclared keys is read on its own too: validation deletes them, and V8 keeps an
// object it deleted a key from in dictionary mode unless the store hands out a copy.

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

interface Provider<T> {
  get(): T
}

const tokens = {
  configToken: Symbol('bench.config') as never,
  liveConfigToken: Symbol('bench.config.live') as never,
  storeToken: Symbol('bench.config.store') as never,
}

async function configOf(tree: Tree): Promise<{ snapshot: Tree; live: Provider<Tree> }> {
  const store = await loadConfig<Tree>(
    {
      schema: { '~standard': { version: 1, vendor: 'bench', validate: value => ({ value: value as Tree }) } },
      ...tokens,
      sources: [new InlineConfigSource(tree as unknown as Record<string, unknown>)],
      loadTimeoutMs: 30_000,
    },
    { start: false },
  )

  // What `ConfigModule` binds under the live token.
  return { snapshot: store.current as Tree, live: { get: () => store.current as Tree } }
}

const trees = Array.from({ length: SHAPES }, (_, i) => freezeDeep(makeTree(i)))
const plains = trees
const loaded = await Promise.all(trees.map(configOf))
const snapshots = loaded.map(l => l.snapshot)
const lives = loaded.map(l => l.live)

// Declares the read path only, so `x0`, `y0` and `z0` are dropped at every level.
const serverSchema = $t.Object({ host: $t.String(), port: $t.Number() })
const cleaned = await loadConfig<Tree>(
  {
    schema: $t.Object({ app: $t.Object({ server: serverSchema, replica: serverSchema }) }) as ConfigSchema<Tree>,
    ...tokens,
    sources: [new InlineConfigSource(trees[0] as unknown as Record<string, unknown>)],
    loadTimeoutMs: 30_000,
  },
  { start: false },
)
const droppedSnapshot = cleaned.current as Tree

// One function per case and per call site, so no two benchmarks share an inline cache.
const plainMono = (c: Tree): number => c.app.server.port
const plainMega = (c: Tree): number => c.app.server.port
const snapshotMono = (c: Tree): number => c.app.server.port
const snapshotMega = (c: Tree): number => c.app.server.port
const snapshotDroppedMono = (c: Tree): number => c.app.server.port
const liveMono = (p: Provider<Tree>): number => p.get().app.server.port
const liveMega = (p: Provider<Tree>): number => p.get().app.server.port

let i = 0
const next = (): number => (i = (i + 1) & (SHAPES - 1))

group('monomorphic: c.app.server.port', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMono(plains[0])))
    bench('snapshot (store.current, ctx.config, config token)', () => do_not_optimize(snapshotMono(snapshots[0])))
    bench('snapshot, after the schema dropped undeclared keys', () =>
      do_not_optimize(snapshotDroppedMono(droppedSnapshot)))
    bench('live token: p.get().app.server.port', () => do_not_optimize(liveMono(lives[0])))
  })
})

group('megamorphic: c.app.server.port over 8 shapes', () => {
  summary(() => {
    bench('control: plain frozen object', () => do_not_optimize(plainMega(plains[next()])))
    bench('snapshot (store.current, ctx.config, config token)', () => do_not_optimize(snapshotMega(snapshots[next()])))
    bench('live token: p.get().app.server.port', () => do_not_optimize(liveMega(lives[next()])))
  })
})

await run({ colors: process.stdout.isTTY === true })
