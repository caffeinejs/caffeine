import { ErrConfiguration } from '@caffeinejs/http'
import {
  defineFeatureConfig,
  type ConfigLocation,
  type ConfigDefinition,
  type ConfigHandle,
  type ConfigSlice,
} from '@caffeinejs/std/config'

import { VIEW_CONFIG_KEYS, viewConfigSchema, type ViewConfig } from './config.js'
import type { ViewOptions } from './view.js'

/**
 * ViewBuilder configures a single SSR (Server-Side Rendering) engine, powered by the `@fastify/view`
 * plugin. The same options used to configure the `@fastify/view` plugin can be used to configure the
 * Caffeine's SSR. In case the builder does not provide a specific option, use the `configure` method to
 * set any option supported by the `@fastify/view` plugin.
 *
 * One builder assembles one engine registration. Multiple engines are declared with
 * `.extend(ViewExt(), …)` and `.extend(ViewExt('mail'), …)`; the {@link ViewOptionsProvider}
 * owns them and reads each via {@link build}.
 *
 * Everything `@fastify/view` takes as data — `root`, `viewExt`, `layout`, the production cache — is read
 * from the configuration tree at `view.<name>.*`, the unnamed engine at `view.default.*`. So `v.root('src')`
 * is a **default**: `VIEW__DEFAULT__ROOT=/srv/templates` overrides it. The engine itself stays code-only.
 *
 * `C` is the application config type, so the selector argument is a `ConfigHandle<C>`.
 *
 * @see https://github.com/fastify/point-of-view
 */
export class ViewBuilder<C = unknown> {
  readonly #name: string | undefined
  #options: Partial<ViewOptions> = {}
  #selector?: (c: ConfigHandle<C>) => ConfigLocation<ViewConfig>
  #resolved: ConfigSlice<ViewOptions> | undefined

  /**
   * @param name - The engine registration name (`@fastify/view`'s `propertyName`), decorating
   *   `reply.<name>`. `undefined` is the default engine, decorating `reply.view`.
   */
  constructor(name?: string) {
    this.#name = name
  }

  /** Engine registration name; `undefined` is the default `reply.view`. */
  get engineName(): string | undefined {
    return this.#name
  }

  /**
   * Configures the template engine.
   * Accepted engines are: ejs, eta, nunjucks, pug, handlebars, mustache, twig, liquid, dot, edge, squirrelly.
   *
   * @param engine - The template engine.
   * @param options - The engine-specific options.
   */
  engine(engine: ViewOptions['engine'], options?: object): this {
    this.#options.engine = engine
    this.#options.options = options

    return this
  }

  /**
   * Directory (or directories) templates are resolved against. An array searches each path in order
   * (first match wins) — enabling feature-folder views with a shared layout root, e.g.
   * `['src/orders/views', 'src/users/views', 'src/shared/layouts']`.
   *
   * Array roots are **engine-dependent**: `@fastify/view` only honors them for **Nunjucks** (it throws for
   * Handlebars/EJS/etc). With a single-root engine, use one `root` and namespaced template names
   * (`View('orders/list')`). `@fastify/view` accepts `string[]` at runtime though its types declare only
   * `string`, hence the cast.
   */
  root(root: string | string[]): this {
    this.#options.root = root as ViewOptions['root']
    return this
  }

  /**
   * Default template extension (e.g. `'hbs'`), so handlers can return `View('home')` without it.
   */
  extension(ext: string): this {
    this.#options.viewExt = ext
    return this
  }

  /**
   * Default layout template wrapped around every rendered view.
   */
  layout(path: string): this {
    this.#options.layout = path
    return this
  }

  /**
   * Data merged into every template's model.
   */
  defaultContext(context: object): this {
    this.#options.defaultContext = context
    return this
  }

  /**
   * Engine-specific options forwarded to the underlying engine.
   */
  options(engineOptions: object): this {
    this.#options.options = engineOptions
    return this
  }

  /**
   * Toggles `@fastify/view`'s production template cache.
   */
  production(production: boolean): this {
    this.#options.production = production
    return this
  }

  /**
   * Merges a full `@fastify/view` options object over anything set so far (last write wins). The escape
   * hatch for knobs without a fluent setter (`charset`, `maxCache`, `includeViewExtension`,
   * `propertyName`, `templates`, ...). Interleaves with the fluent setters by call order.
   */
  configure(options: Partial<ViewOptions>): this {
    Object.assign(this.#options, options)
    return this
  }

  /**
   * Places this engine's settings elsewhere in the configuration tree, e.g. `v.config(c => c.app.templates)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigLocation<ViewConfig>): this {
    this.#selector = selector
    return this
  }

  /**
   * Framework-internal: registers this engine's slice. Called by {@link ViewOptionsProvider} at
   * `configure()`, before the container initializes.
   *
   * The engine check happens here rather than in {@link build}, so a missing engine still fails at start-up:
   * `build()` cannot run until configuration has resolved, and by then the adapter is already wiring routes.
   */
  register(definition: ConfigDefinition): void {
    if (!this.#options.engine) {
      throw new ErrConfiguration('Engine is required to configure Server-Side Rendering')
    }

    const code = this.#options

    const slice = defineFeatureConfig<ViewConfig>(definition, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: viewConfigSchema,
      values: Object.fromEntries(
        VIEW_CONFIG_KEYS.filter(key => code[key as keyof ViewOptions] !== undefined).map(key => [
          key,
          code[key as keyof ViewOptions],
        ]),
      ),
    })

    this.#resolved = slice.derive(
      published =>
        ({
          // Code first, configuration over it: a builder method is a default, like everywhere else. `engine` and
          // the engine's own options only exist on the code side and survive untouched.
          ...code,
          ...published,
          ...(this.#name === undefined ? {} : { propertyName: this.#name }),
        }) as ViewOptions,
    )
  }

  /**
   * Assembles the `@fastify/view` options for this engine registration, stamping `propertyName` when the
   * builder is named.
   *
   * Once {@link register} has run this reads through the slice, so what an application gets is the merged
   * configuration — and reading it too early throws from the slice itself. A builder that was never
   * registered has no configuration system behind it at all and simply reports what was set in code, which
   * is what a standalone use (a unit test, a hand-assembled registration) means by `build()`.
   */
  build(): ViewOptions {
    if (this.#resolved !== undefined) {
      return this.#resolved.config
    }

    if (!this.#options.engine) {
      throw new ErrConfiguration('Engine is required to configure Server-Side Rendering')
    }

    if (this.#name !== undefined) {
      this.#options.propertyName = this.#name
    }

    return this.#options as ViewOptions
  }
}
