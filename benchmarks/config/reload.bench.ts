import { CaffeineIoC, token } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  type ConfigHandle,
  ConfigDefinition,
  ConfigModule,
  EnvConfigProvider,
  InlineConfigProvider,
  MutableConfigProvider,
} from '@caffeinejs/std/config'
import { bench, do_not_optimize, run } from 'mitata'

// What one reload costs when one live source changed one value: 448 leaves, 4 levels deep, 4 sources, validated
// against a `$t` schema.

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

const key = token<ConfigHandle<Tree>>(Symbol('bench.config'))
const definition = new ConfigDefinition(key)
definition.schema = makeSchema()

const mutable = new MutableConfigProvider('live')
definition.sources.addAll([
  new InlineConfigProvider(makeTree('default') as never, 'defaults'),
  new InlineConfigProvider(makeTree('file') as never, 'file'),
  new EnvConfigProvider({ env: { SECTION0__GROUP0__KEY0: 'env', SECTION3__GROUP2__KEY5: 'env' } }),
  mutable,
])

const container = new CaffeineIoC({ decorators: false })
container.addModules(ConfigModule(definition))
await container.init()

const config = container.get(key)
let flip = false

bench('today: one value written, one refresh of the whole tree', async () => {
  flip = !flip
  mutable.set('section1.group1.key1', flip ? 'a' : 'b')
  await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
  do_not_optimize(config.section1.group1.key1)
})

await run()
