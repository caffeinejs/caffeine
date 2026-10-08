import { kFeatureName, type Feature } from '@caffeinejs/std'
import { errMessage } from '@caffeinejs/std/framework/err'

import { ErrConfiguration } from './error/common.js'

/**
 * Refuses what a `.with(...)` was handed when it is not a plugin factory. The compiler already refuses a feature
 * there; this catches one smuggled past it, where the silent alternative would be an extension the adapter cannot
 * install.
 *
 * @throws ErrConfiguration when `factory` is not a function.
 */
export function assertPluginFactory(factory: unknown): void {
  if (typeof factory === 'function') {
    return
  }

  // Read only off an object: `null` and `undefined` reach the refusal below instead of a `TypeError`.
  const name = typeof factory === 'object' && factory !== null ? (factory as Partial<Feature>)[kFeatureName] : undefined
  const got = factory === null ? 'null' : typeof factory

  throw new ErrConfiguration(
    (typeof name === 'string'
      ? errMessage(`Cannot register feature "${name}" with ".with(...)": a feature is not a server plugin`).solutions(
          'Install a feature with ".install(...)", at any position in the chain',
        )
      : errMessage(`Cannot register an HTTP plugin: expected a plugin factory function, got ${got}`).solutions(
          'Pass a factory: ".with(({ config }) => [plugin, options])"',
          'Install a feature with ".install(feature)"',
        )
    )
      .reference('@caffeinejs/http', ErrConfiguration)
      .build(),
  )
}
