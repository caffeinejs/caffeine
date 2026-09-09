import { ErrConfiguration } from '@caffeinejs/http'
import { type Feature } from '@caffeinejs/std'

import { ViewBuilder } from './builder.js'
import { ViewOptionsProvider } from './options_provider.js'

const PROVIDER = 'view:provider'
const DEFAULT_ENGINE = 'default'

/**
 * The `@caffeinejs/view` application feature. `.extend(ViewExt(), v => …)` registers the default engine
 * (`reply.view`); `.extend(ViewExt('mail'), v => …)` registers a named one. `"view"` is reserved for the
 * default engine.
 *
 * The first install creates a {@link ViewOptionsProvider} and registers it as a feature; later named
 * installs add engines to that provider.
 */
export function ViewExt(engine: string = DEFAULT_ENGINE): Feature<ViewBuilder> {
  return {
    name: engine === DEFAULT_ENGINE ? 'view' : `view:${engine}`,
    install(ctx, configure) {
      if (engine === 'view') {
        throw new ErrConfiguration('Cannot register a view engine named "view": it is reserved for the default engine')
      }

      let provider = ctx.state.get(PROVIDER) as ViewOptionsProvider | undefined
      if (provider == null) {
        provider = new ViewOptionsProvider()
        ctx.state.set(PROVIDER, provider)
        ctx.addFeature(provider)
      }

      const builder = new ViewBuilder(engine === DEFAULT_ENGINE ? undefined : engine)
      configure?.(builder)
      provider.add(builder)
    },
  }
}
