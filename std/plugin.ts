import type { Container } from '@caffeinejs/di'

import type { ApplicationEvent } from './decorators/lifecycle_registry.js'
import { ErrCaffeine } from './error.js'
import type { Service } from './service.js'

/**
 * Runtime seam handed to a feature at install time. A feature registers its configurer via
 * {@link addService} (it rides the same `bootstrap()` path as the built-in services), may read the DI
 * {@link container}, and may register programmatic lifecycle listeners via {@link on}.
 *
 * {@link state} is per application builder. A feature const must not keep install flags on itself —
 * two `createApplication()` calls in one process would share them.
 */
export interface PluginContext {
  addService(service: Service): void
  readonly container: Container
  on(event: ApplicationEvent, listener: (app: { readonly container: Container }) => void | Promise<void>): void
  readonly state: Map<string, unknown>
}

/**
 * A feature installed with `.extend(feature, configure?)`. `B` is the builder handed to `configure`.
 *
 * Features that select from application config declare a phantom {@link TypeLambda} as `_F`
 * so {@link BuilderOf} can rebind the builder against the application config type.
 */
export interface Feature<B = unknown> {
  readonly name: string
  install(ctx: PluginContext, configure?: (builder: B) => void): void
}

/**
 * A {@link Feature} that is also callable to name an instance: `kafka` is the default,
 * `kafka('orders')` is a distinct install.
 *
 * Declared as an interface (call signature plus methods) so TypeScript does not collapse it to a
 * function type and drop phantoms such as `__builder`.
 */
export interface KeyedFeature<B = unknown> extends Feature<B> {
  (instance: string): Feature<B>
}

/**
 * Higher-kinded placeholder so a feature can name `Builder<C>` without knowing `C` yet.
 * {@link BuilderOf} instantiates it against the application config type.
 */
export interface TypeLambda {
  readonly In: unknown
  readonly Out: unknown
}

/**
 * Recovers the builder type a feature hands to `.extend`'s callback, rebound to config type `C`.
 */
export type BuilderOf<F, C> = F extends { readonly _F: infer L }
  ? L extends TypeLambda
    ? (L & { readonly In: C })['Out']
    : F extends Feature<infer B>
      ? B
      : never
  : F extends Feature<infer B>
    ? B
    : never

/** Thrown when `.extend` installs the same singleton feature, or the same keyed instance, twice. */
export class ErrFeatureAlreadyInstalled extends ErrCaffeine {
  constructor(feature: string, instance?: string) {
    super(
      instance === undefined
        ? `Cannot install feature "${feature}": it is already installed`
        : `Cannot install feature "${feature}" instance "${instance}": it is already installed`,
      'ERR_FEATURE_ALREADY_INSTALLED',
    )
  }
}

function claim(ctx: PluginContext, feature: string, instance?: string): void {
  const key = instance === undefined ? feature : `${feature}:${instance}`
  if (ctx.state.has(key)) {
    throw new ErrFeatureAlreadyInstalled(feature, instance)
  }
  ctx.state.set(key, true)
}

/**
 * Declares a feature that `.extend` installs at most once. `install` creates the builder, runs
 * `configure` if given, and registers the service.
 */
export function defineFeature<B>(options: {
  readonly name: string
  readonly singleton?: boolean
  install(ctx: PluginContext, configure?: (builder: B) => void): void
}): Feature<B> {
  return {
    name: options.name,
    install(ctx, configure) {
      if (options.singleton) {
        claim(ctx, options.name)
      }
      options.install(ctx, configure)
    },
  }
}

/**
 * Declares a feature that may be installed once per instance name. The returned value is the default
 * instance; calling it with a name produces another {@link Feature} for that instance.
 */
export function defineKeyedFeature<B>(options: {
  readonly name: string
  readonly defaultInstance: string
  install(ctx: PluginContext, instance: string, configure?: (builder: B) => void): void
}): KeyedFeature<B> {
  function make(instance: string): Feature<B> {
    return {
      name: options.name,
      install(ctx, configure) {
        claim(ctx, options.name, instance)
        options.install(ctx, instance, configure)
      },
    }
  }

  const def = make(options.defaultInstance)
  const keyed = Object.assign((instance: string) => make(instance), {
    install: (ctx: PluginContext, configure?: (builder: B) => void) => def.install(ctx, configure),
  }) as KeyedFeature<B>
  Object.defineProperty(keyed, 'name', { value: options.name })
  return keyed
}
