import type { Container } from '@caffeinejs/di'
import type { Service } from './service.js'

/**
 * Runtime seam handed to a plugin at install time. A plugin registers its configurer via
 * {@link addService} (it rides the same `[kServiceConfigure]` path as the built-in services) and may read
 * the DI {@link container} to bind eagerly if it needs to.
 */
export interface PluginContext {
  addService(service: Service): void
  readonly container: Container
}

/**
 * A builder plugin augments the application builder with extra, fully-typed methods. `Ext` is the record of
 * methods the plugin contributes to the builder surface; the factory merges every plugin's `Ext` into the
 * returned builder's type so the methods are visible with autocomplete.
 */
export interface Plugin<Ext extends object = object> {
  readonly name: string
  install(ctx: PluginContext): Ext
}

type UnionToIntersection<U>
  = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

type ExtOf<P> = P extends Plugin<infer E> ? E : never

/**
 * Accumulates the method records of every plugin in `S` into a single intersection. The empty-tuple guard
 * maps "no plugins" to `object` (a no-op intersection) instead of `never`, so a plugin-less builder still
 * types as a plain builder.
 */
export type Augment<S extends readonly Plugin[]>
  = [S[number]] extends [never] ? object : UnionToIntersection<ExtOf<S[number]>>
