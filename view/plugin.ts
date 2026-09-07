import { ErrConfiguration } from '@caffeinejs/http'
import { defineKeyedFeature, type KeyedFeature, type TypeLambda } from '@caffeinejs/std'

import { ViewBuilder } from './builder.js'
import { ViewOptionsProvider } from './options_provider.js'

const PROVIDER = 'view:provider'
const DEFAULT_ENGINE = 'default'

interface ViewBuilderF extends TypeLambda {
  readonly Out: ViewBuilder<this['In']>
}

export interface ViewFeature extends KeyedFeature<ViewBuilder, ViewBuilderF> {
  readonly _F: ViewBuilderF
}

/**
 * The `@caffeinejs/view` application feature. `.extend(ViewExt, v => …)` registers the default engine
 * (`reply.view`); `.extend(ViewExt('mail'), v => …)` registers a named one. `"view"` is reserved for the
 * default engine.
 *
 * The first install creates a {@link ViewOptionsProvider} and registers it as a service; later named
 * installs add engines to that provider.
 */
export const ViewExt: ViewFeature = defineKeyedFeature({
  name: 'view',
  defaultInstance: DEFAULT_ENGINE,
  install(ctx, instance, configure) {
    if (instance === 'view') {
      throw new ErrConfiguration('Cannot register a view engine named "view": it is reserved for the default engine')
    }

    let provider = ctx.state.get(PROVIDER) as ViewOptionsProvider | undefined
    if (provider == null) {
      provider = new ViewOptionsProvider()
      ctx.state.set(PROVIDER, provider)
      ctx.addService(provider)
    }

    const builder = new ViewBuilder(instance === DEFAULT_ENGINE ? undefined : instance)
    configure?.(builder)
    provider.add(builder)
  },
}) as ViewFeature
