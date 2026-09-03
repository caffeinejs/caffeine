import { CaffeineIoC } from '../../../container.js'
import { token } from '../../../key.js'

export type ChildScenario = {
  parentOnly: string[]
  childOnly: string[]
  shared: { key: string; parentValue: string; childValue: string }[]
}

export function buildChildScenario(scenario: ChildScenario): { parent: CaffeineIoC; child: CaffeineIoC } {
  const parent = new CaffeineIoC({ decorators: false })

  for (const key of scenario.parentOnly) {
    parent.bind(token<string>(key), t => t.toValue(`parent-${key}`))
  }

  for (const entry of scenario.shared) {
    parent.bind(token<string>(entry.key), t => t.toValue(entry.parentValue))
  }

  const child = parent.newChild()

  for (const key of scenario.childOnly) {
    child.bind(token<string>(key), t => t.toValue(`child-${key}`))
  }

  for (const entry of scenario.shared) {
    child.bind(token<string>(entry.key), t => t.toValue(entry.childValue))
  }

  return { parent, child }
}
