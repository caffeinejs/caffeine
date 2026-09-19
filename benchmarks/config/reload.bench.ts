import { $t } from '@caffeinejs/std'
import {
  EnvConfigSource,
  InlineConfigSource,
  loadConfig,
  MutableConfigSource,
  type ConfigSchema,
} from '@caffeinejs/std/config'
import { bench, do_not_optimize, run, summary } from 'mitata'

// What one reload costs: 448 leaves, 4 levels deep, 4 sources, validated against a `$t` schema. One case writes one
// value to the live source; the other reloads it with nothing written, which must cost only the load.

type Tree = Record<string, Record<string, Record<string, unknown>>>

function makeTree(seed: string): Tree {
  const root: Tree = {}
  for (let a = 0; a < 6; a++) {
    const section: Record<string, Record<string, unknown>> = {}
    for (let b = 0; b < 5; b++) {
      const group: Record<string, unknown> = {}
      for (let c = 0; c < 8; c++) {
        group[`key${c}`] = `${seed}-${a}-${b}-${c}`
      }
      group.tags = ['a', 'b', 'c']
      group.servers = [
        { host: 'h1', port: 1 },
        { host: 'h2', port: 2 },
      ]
      section[`group${b}`] = group
    }
    root[`section${a}`] = section
  }
  return root
}

function makeSchema() {
  const group: Record<string, ReturnType<typeof $t.String> | ReturnType<typeof $t.Array>> = {}
  for (let c = 0; c < 8; c++) {
    group[`key${c}`] = $t.String()
  }
  group.tags = $t.Array($t.String())
  group.servers = $t.Array($t.Object({ host: $t.String(), port: $t.Number() }))

  const sections: Record<string, ReturnType<typeof $t.Object>> = {}
  for (let a = 0; a < 6; a++) {
    const groups: Record<string, ReturnType<typeof $t.Object>> = {}
    for (let b = 0; b < 5; b++) {
      groups[`group${b}`] = $t.Object(group)
    }
    sections[`section${a}`] = $t.Object(groups)
  }
  return $t.Object(sections)
}

const mutable = new MutableConfigSource('live')
const store = await loadConfig<Tree>(
  {
    schema: makeSchema() as ConfigSchema<Tree>,
    key: undefined,
    storeKey: undefined,
    sources: [
      new InlineConfigSource(makeTree('default'), 'defaults'),
      new InlineConfigSource(makeTree('file'), 'file'),
      new EnvConfigSource({ env: { SECTION0__GROUP0__KEY0: 'env', SECTION3__GROUP2__KEY5: 'env' } }),
      mutable,
    ],
    loadTimeoutMs: 30_000,
  },
  { start: false },
)

const live = store.live
let flip = false

summary(() => {
  bench('one value written, one reload', async () => {
    flip = !flip
    mutable.set('section1.group1.key1', flip ? 'a' : 'b')
    await store.reload()
    do_not_optimize(live.section1.group1.key1)
  })

  bench('nothing written, one reload', async () => {
    await store.reload()
    do_not_optimize(live.section1.group1.key1)
  })
})

await run()
