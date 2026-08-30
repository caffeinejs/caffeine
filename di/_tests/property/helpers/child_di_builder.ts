import { CaffeineIoC } from '../../../container.js'
import { token } from '../../../key.js'

export type ChildScenario = {
  parentOnly: string[]
  childOnly: string[]
  shared: { key: string, parentValue: string, childValue: string }[]
}

export function buildChildScenario(scenario: ChildScenario): { parent: CaffeineIoC, child: CaffeineIoC } {
  const parent = new CaffeineIoC({ decorators: false })

  for (const key of scenario.parentOnly) {
    parent.bind(token<any>(key))
      .toValue(`parent-${key}`)
  }

  for (const entry of scenario.shared) {
    parent.bind(token<any>(entry.key))
      .toValue(entry.parentValue)
  }

  const child = parent.newChild()

  for (const key of scenario.childOnly) {
    child.bind(token<any>(key))
      .toValue(`child-${key}`)
  }

  for (const entry of scenario.shared) {
    child.bind(token<any>(entry.key))
      .toValue(entry.childValue)
  }

  return { parent, child }
}
