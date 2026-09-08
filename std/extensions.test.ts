import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Extensions, kExtensionStage, type Extension, type ExtensionIn, type ExtensionStage } from './extensions.js'

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

class Core extends Probe {
  readonly name = 'core'
  readonly [kExtensionStage]: ExtensionStage = 'core'
}
class Fallback extends Probe {
  readonly name = 'fallback'
  readonly [kExtensionStage]: ExtensionStage = 'fallback'
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

  // What the stage exists for: the framework's own wiring brackets everything a package contributes, whatever
  // order the application's `.extend(...)` calls happen to be written in.
  it('runs core before default and fallback after, whatever the install order says', async () => {
    const extensions = new Extensions(await containerWith(First, Core, Fallback))

    extensions.at(0).add(Fallback)
    extensions.at(1).add(First)
    extensions.at(2).add(Core)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['core', 'first', 'fallback'])
  })

  it('falls back to install order within one stage', async () => {
    const extensions = new Extensions(await containerWith(First, Second, Core))

    extensions.at(0).add(Second)
    extensions.at(1).add(Core)
    extensions.at(2).add(First)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['core', 'second', 'first'])
  })

  // An extension that says nothing is a third-party one, and must not land in a framework band.
  it('treats an unmarked extension as default', async () => {
    const extensions = new Extensions(await containerWith(First, Fallback))

    extensions.at(0).add(Fallback)
    extensions.at(1).add(First)

    expect(extensions.of(Probe).map(p => p.name)).toEqual(['first', 'fallback'])
  })

  it('binds and registers in one call', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const extensions = new Extensions(container)
    const instance = new First()

    extensions.at(0).register(First, instance)
    await container.init()

    expect(extensions.of(Probe)).toEqual([instance])
    expect(container.get(First)).toBe(instance)
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
