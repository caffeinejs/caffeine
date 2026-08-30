import { Binding } from '../../binding.js'
import { ErrInvalidDecorator } from '../../errors.js'
import { notNil } from '../../internal/util/assert/index.js'
import { Identifier, InjectionToken } from '../../key.js'
import { Injection } from '../../injection.js'
import { normalizeInjections } from '../util/util.js'
import { idfy, MemberKind, TypeID } from './types.js'
import { DecoratedBindingConfig, MemberMetadata } from './spec.js'

const Bindings = new Map<InjectionToken, DecoratedBindingConfig>()
const ByProfile = new Map<Identifier, Set<InjectionToken>>()
const ProvidedBindings: Array<[InjectionToken, DecoratedBindingConfig]> = []
const MetadataWeakMap = new WeakMap<TypeID, MemberMetadata>()
const Injectables = new Set<InjectionToken>()

/**
 * Marks a class as an injectable and optionally configure its binding.
 */
export function defineInjectable<T>(
  id: TypeID,
  key: InjectionToken<T>,
  configure: (config: DecoratedBindingConfig) => void,
): DecoratedBindingConfig {
  Injectables.add(key)

  const binding = getOrCreateBindingConfiguration(key)

  if (binding.hasMetadataBeenMerged()) {
    configure(binding)
    return binding
  }

  binding.mergeMetadata(getInjectionMetadata(id))

  configure(binding)

  return binding
}

/**
 * Extends the binding configuration for an injectable class.
 * Configuration is cumulative for collection fields.
 */
export function extendInjectableAttributes<T>(
  id: TypeID,
  key: InjectionToken<T>,
  configure: (config: DecoratedBindingConfig) => void,
): void {
  notNil(key)

  const binding = getOrCreateBindingConfiguration(key)

  if (binding.hasMetadataBeenMerged()) {
    configure(binding)
    return
  }

  binding.mergeMetadata(getInjectionMetadata(id))

  configure(binding)
}

export function defineMemberInjection<T = unknown>(
  id: TypeID,
  name: string | symbol,
  kind: MemberKind,
  singleOrMultipleInjections: Injection<T> | Injection[],
): void {
  const metadata = getInjectionMetadata(idfy(id))
  const injections = normalizeInjections(
    Array.isArray(singleOrMultipleInjections)
      ? singleOrMultipleInjections
      : [singleOrMultipleInjections])

  switch (kind) {
    case 'method': {
      metadata.injectableMethod(name, injections)
      break
    }

    case 'field':
    case 'accessor':
    case 'getter':
    case 'setter':
      metadata.injectableProperty(name, injections[0])
      break
  }
}

/**
 * Extends the binding configuration for an injectable member.
 * Configuration is cumulative for collection fields.
 */
export function extendMemberInjectableAttributes(
  metaID: TypeID,
  name: string | symbol,
  configure: (config: DecoratedBindingConfig) => void,
): void {
  const metadata = getInjectionMetadata(idfy(metaID))

  try {
    configure(metadata.memberFor(name))
  } catch (error: unknown) {
    throw new ErrInvalidDecorator(
      `Invalid decorator configuration for member "${String(name)}" on class "${String(metaID)}":\n${(error as Error).message}`,
    )
  }
}

/**
 * Checks if a binding is registered for the given key.
 */
export function hasInjectable(key: InjectionToken): boolean {
  return Injectables.has(key)
}

/**
 * Gets the injection metadata for the given object.
 */
export function getInjectionMetadata(id: TypeID): MemberMetadata {
  let meta = MetadataWeakMap.get(id)
  if (meta) {
    return meta
  }

  meta = new MemberMetadata()

  MetadataWeakMap.set(id, meta)

  return meta
}

/**
 * Gets the binding configuration for the given key.
 */
export function getBindingConfiguration(key: InjectionToken): DecoratedBindingConfig | undefined {
  return Bindings.get(notNil(key))
}

function getOrCreateBindingConfiguration(key: InjectionToken): DecoratedBindingConfig {
  let binding = Bindings.get(key)
  if (!binding) {
    binding = new DecoratedBindingConfig(key)
    Bindings.set(key, binding)
  }

  return binding
}

/**
 * Gets all decorated binding configurations.
 * The container uses this function to retrieve decorated bindings; profile matching happens later.
 */
export function getBindingConfigurations(): IterableIterator<[InjectionToken, DecoratedBindingConfig]> {
  return Bindings.entries()
}

/**
 * Gets the provided bindings from configuration classes.
 */
export function providedBindingConfigurations(): Array<[InjectionToken, DecoratedBindingConfig]> {
  return ProvidedBindings
}

/**
 * Configures a provided binding from a configuration class.
 */
export function addProvidedBindings<T>(key: InjectionToken<T>, config: DecoratedBindingConfig): void {
  notNil(key)
  notNil(config)

  ProvidedBindings.push([key, config])
}

/**
 * Converts a binding decorator configuration to a binding configuration.
 */
export function decoratorConfigToBinding<T>(config: DecoratedBindingConfig): Binding<T> {
  return config.binding()
}

// Testing Utilities

/**
 * Represents a snapshot of the registry.
 */
export interface DecoratorRegistrySnapshot {
  readonly bindings: Map<InjectionToken, DecoratedBindingConfig>
  readonly byProfile: Map<Identifier, Set<InjectionToken>>
  readonly providedBindings: Array<[InjectionToken, DecoratedBindingConfig]>
  readonly injectables: Set<InjectionToken>
}

/**
 * Creates a snapshot of the registry.
 */
export function snapshotDecoratorRegistry(): DecoratorRegistrySnapshot {
  return {
    bindings: new Map(Bindings),
    byProfile: new Map([...ByProfile.entries()].map(([k, v]) => [k, new Set(v)])),
    providedBindings: [...ProvidedBindings],
    injectables: new Set(Injectables),
  }
}

/**
 * Restores the registry from a snapshot.
 */
export function restoreDecoratorRegistry(snapshot: DecoratorRegistrySnapshot): void {
  Bindings.clear()
  for (const [k, v] of snapshot.bindings) {
    Bindings.set(k, v)
  }

  ByProfile.clear()
  for (const [k, v] of snapshot.byProfile) {
    ByProfile.set(k, new Set(v))
  }

  ProvidedBindings.length = 0
  for (const entry of snapshot.providedBindings) {
    ProvidedBindings.push(entry)
  }

  Injectables.clear()
  for (const k of snapshot.injectables) {
    Injectables.add(k)
  }
}
