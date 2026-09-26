import type { Binding } from '../../../binding.js'
import { DeferredCtor } from '../../../deferred_ctor.js'
import { ErrMissingInjectionKey, ErrNoResolutionForKey, ErrNoValuesProvider } from '../../../errors.js'
import type { InjectionMiddleware } from '../../../injection_resolver.js'
import { Identifier, keyStr, TypedKey } from '../../../key.js'
import type { Provider } from '../../../provider.js'
import { Keys } from '../../../symbols.js'
import { solutions } from '../../util/errutil/index.js'
import { excludeSelf, uniqueBindingOrThrow } from './_binding_util.js'
import { describeContext } from './_fmt.js'

// Every stage here does its work while the container compiles and returns the thunk the resolution path calls.
// A stage that only rearranges bindings hands back `next(...)` untouched, so it costs nothing per resolution,
// and a stage that wraps hoists whatever it allocates out of the thunk it returns.

const byOrder = (a: Binding<unknown>, b: Binding<unknown>): number => (a.order ?? Infinity) - (b.order ?? Infinity)

/**
 * Sorts the bindings by their configured order, ascending.
 *
 * Bindings without an order go last, keeping their registration order among themselves, which is what makes the
 * sort stable.
 */
export const sortStage: InjectionMiddleware = (ctx, next) => next({ ...ctx, bindings: [...ctx.bindings].sort(byOrder) })

/**
 * Wraps whatever the rest of the chain resolves in a {@link Provider}, so the consumer re-resolves on every read.
 */
export const providerStage: InjectionMiddleware = (ctx, next) => {
  const inner = next(ctx)
  const provider: Provider = { get: inner }

  return () => provider
}

/**
 * Resolves every binding for the key into an array.
 */
export const manyStage: InjectionMiddleware = ctx => {
  const bindings = excludeSelf(ctx.bindings as Binding<unknown>[], ctx.key!, ctx.descriptor.key!, ctx.container)

  return () => {
    const results = new Array<unknown>(bindings.length)

    for (let i = 0; i < bindings.length; i++) {
      results[i] = bindings[i].factory(bindings[i].ctx!)
    }

    return results
  }
}

/**
 * Resolves every named binding for the key into a map keyed by the binding name.
 */
export const mapStage: InjectionMiddleware = ctx => {
  // Distinct from the empty case below: a missing key is a mistake in the injection, not an empty container.
  if (!ctx.descriptor.key) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided` +
        solutions(
          `- Provide an injection key`,
          `- For circular dependencies, use defer(() => key) to defer resolution`,
        ),
    )
  }

  if (ctx.bindings.length === 0) {
    if (ctx.descriptor.optional) {
      return () => undefined
    }

    throw new ErrNoResolutionForKey(
      `${describeContext(ctx)}: no bindings registered for key "${keyStr(ctx.descriptor.key)}"` +
        solutions(`- Register a binding for key "${keyStr(ctx.descriptor.key)}"`),
    )
  }

  // After the emptiness check, as the array terminal does: a key the consumer alone answers to is still bound, so
  // the consumer receives an empty map rather than itself, which it would have to build while being built.
  const bindings = excludeSelf(ctx.bindings as Binding<unknown>[], ctx.key!, ctx.descriptor.key, ctx.container)

  return () => {
    const result = new Map<Identifier, unknown>()

    for (const binding of bindings) {
      if (binding.names.length > 0) {
        result.set(binding.names[0], binding.factory(binding.ctx!))
      }
    }

    return result
  }
}

/**
 * Resolves to a constant carried by the stage itself.
 */
export const valueStage: InjectionMiddleware = (_ctx, _next, args) => () => args

type ConfigArgs = {
  access: ((provider: unknown) => unknown) | string
  defaultValue?: unknown
}

/**
 * Resolves a value out of the registered values provider.
 *
 * @throws {@link ErrNoValuesProvider} when no provider is registered and the stage carries no default.
 */
export const configStage: InjectionMiddleware = (ctx, _next, args) => {
  const { access, defaultValue } = args as ConfigArgs
  const hasDefault = defaultValue !== undefined
  const providerBinding = ctx.container.getBinding(Keys.kValuesProvider) as Binding<unknown> | undefined

  if (!providerBinding) {
    if (hasDefault) {
      return () => defaultValue
    }

    if (!ctx.descriptor.optional) {
      throw new ErrNoValuesProvider(describeContext(ctx))
    }

    return () => undefined
  }

  const select: (provider: unknown) => unknown =
    typeof access === 'string'
      ? (() => {
          const keys = access.split('.')

          return (provider: unknown) =>
            keys.reduce((acc: unknown, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), provider)
        })()
      : (access as (provider: unknown) => unknown)

  return () => {
    const v = select(providerBinding.factory(providerBinding.ctx!))

    return v === undefined && hasDefault ? defaultValue : v
  }
}

/**
 * The terminal a chain gets when it names none: resolve the one binding for the key.
 *
 * A deferred key resolves through a proxy instead, because a genuine constructor cycle cannot be resolved at the
 * moment the consumer is built. An optional deferred key does not: the caller asked to be handed `undefined`
 * rather than a stand-in.
 */
export const uniqueStage: InjectionMiddleware = ctx => {
  const rawKey = ctx.descriptor.key

  if (rawKey instanceof DeferredCtor && !ctx.descriptor.optional) {
    return () => rawKey.createProxy(target => ctx.container.get(target as TypedKey<unknown>))
  }

  if (!rawKey) {
    throw new ErrMissingInjectionKey(
      `${describeContext(ctx)}: no injection key provided` +
        solutions(
          `- Provide an injection key`,
          `- For circular dependencies, use defer(() => key) to defer resolution`,
        ),
    )
  }

  const key = (rawKey instanceof DeferredCtor ? rawKey.unwrap() : rawKey) as TypedKey<unknown>
  const binding = uniqueBindingOrThrow(ctx, key)

  if (!binding) {
    if (ctx.descriptor.optional) {
      return () => undefined
    }

    throw new ErrNoResolutionForKey(
      `${describeContext(ctx)}: no binding registered for key "${keyStr(key)}"` +
        solutions(
          `- Register a binding for key "${keyStr(key)}"`,
          `- If the dependency is optional, use optional(key)`,
        ),
    )
  }

  return () => binding.factory(binding.ctx!)
}
