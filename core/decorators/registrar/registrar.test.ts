import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Injectable } from '../injectable.js'
import {
  snapshotDecoratorRegistry,
  restoreDecoratorRegistry,
  getBindingConfiguration,
  hasInjectable,
  type DecoratorRegistrySnapshot,
} from './registrar.js'

describe('snapshotRegistry / restoreRegistry', function () {
  let snap: DecoratorRegistrySnapshot

  beforeEach(function () {
    snap = snapshotDecoratorRegistry()
  })

  afterEach(function () {
    restoreDecoratorRegistry(snap)
  })

  it('new decorated class appears in registry', function () {
    @Injectable()
    class Transient {}

    expect(hasInjectable(Transient)).toBe(true)
    expect(getBindingConfiguration(Transient)).toBeDefined()
  })

  it('restoreRegistry removes class registered during test', function () {
    @Injectable()
    class Temporary {}

    expect(hasInjectable(Temporary)).toBe(true)

    restoreDecoratorRegistry(snap)

    expect(hasInjectable(Temporary)).toBe(false)
    expect(getBindingConfiguration(Temporary)).toBeUndefined()
  })

  it('restoreRegistry preserves classes that existed before snapshot', function () {
    @Injectable()
    class PreExisting {}

    const innerSnap = snapshotDecoratorRegistry()

    @Injectable()
    class Added {}

    restoreDecoratorRegistry(innerSnap)

    expect(hasInjectable(PreExisting)).toBe(true)
    expect(hasInjectable(Added)).toBe(false)
  })

  it('double restore is idempotent', function () {
    @Injectable()
    class Foo {}

    restoreDecoratorRegistry(snap)
    restoreDecoratorRegistry(snap)

    expect(hasInjectable(Foo)).toBe(false)
  })

  it('snapshot is a copy — mutations after snapshot do not affect it', function () {
    const sizeBefore = snap.injectables.size

    @Injectable()
    class Extra {}

    expect(hasInjectable(Extra)).toBe(true)
    expect(snap.injectables.size).toBe(sizeBefore)
  })
})
