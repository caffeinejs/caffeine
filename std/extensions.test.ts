import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Extensions, type Extension, type ExtensionIn } from './extensions.js'

abstract class Probe implements Extension {
  abstract readonly name: string

  configure(): void {
    // Nothing to do: these tests read the registry, they do not run what it holds.
  }
}

class First extends Probe {
  readonly name = 'first'
}
class Second extends Probe {
  readonly name = 'second'
}
class Third extends Probe {
  readonly name = 'third'
}

/** A registered extension of another kind, which the consumer asking for {@link Probe} must not receive. */
class Other implements Extension<ExtensionIn> {
  readonly name = 'other'

  configure(): void {}
}

async function containerWith(...types: (new () => Extension)[]): Promise<CaffeineIoC> {
  const container = new CaffeineIoC({ decorators: false })
  for (const type of types) {
    container.bind(type, t => t.toValue(new type()))
  }
  await container.init()
  return container
}

describe('Extensions', () => {
  it('returns nothing when no feature registered one', async () => {
    const extensions = new Extensions(await containerWith())

    expect(extensions.of(Probe)).toEqual([])
  })

  // The ordering guarantee: a feature that registers late still lands in its install position.
  it('orders by the registering feature, not by when it registered', async () => {
    const extensions = new Extensions(await containerWith(First, Second, Third))

    extensions.at(2).add(Third)
    extensions.at(0).add(First)
    extensions.at(1).add(Second)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['first', 'second', 'third'])
  })

  it('keeps the order one feature added its own extensions in', async () => {
    const extensions = new Extensions(await containerWith(First, Second))

    extensions.at(0).add(Second)
    extensions.at(0).add(First)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['second', 'first'])
  })

  // Every kind of extension shares one registry, so a consumer only ever gets the ones it can run.
  it('skips a registered extension of another kind', async () => {
    const extensions = new Extensions(await containerWith(First, Other))

    extensions.at(0).add(First)
    extensions.at(1).add(Other)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['first'])
  })

  it('resolves through the container, so a consumer sees the bound instance', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const instance = new First()
    container.bind(First, t => t.toValue(instance))
    await container.init()

    const extensions = new Extensions(container)
    extensions.at(0).add(First)

    expect(extensions.of(Probe)[0]).toBe(instance)
  })
})
