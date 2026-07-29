import { Binding } from '../../binding.js'
import { ErrInvalidDecorator } from '../../errors.js'
import { notNil } from '../../internal/util/assert/index.js'
import { Identifier, Key } from '../../key.js'
import { Injection } from '../../injection.js'
import { normalizeInjections } from '../util/util.js'
import { idfy, MemberKind, TypeID } from './types.js'
import { DecoratedBindingConfig, MemberMetadata } from './spec.js'

const Bindings = new Map<Key, DecoratedBindingConfig>()
const ByProfile = new Map<Identifier, Set<Key>>()
const ProvidedBindings = new Map<Identifier, Array<[Key, DecoratedBindingConfig]>>()
const MetadataWeakMap = new WeakMap<TypeID, MemberMetadata>()
const Injectables = new Set<Key>()

/**
 * Marks a class as an injectable and optionally configure its binding.
 */
export function defineInjectable<T>(
  id: TypeID,
  key: Key<T>,
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
 *
 * @framework
 */
export function extendInjectableAttributes<T>(
  id: TypeID,
  key: Key<T>,
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

  // const info = mergeObject<BindingDecoratorConfig<T>>(
  //   existing ?? ({} as BindingDecoratorConfig<T>),
  //   opts as BindingDecoratorConfig<T>,
  // )

  // if (existing && existing.profiles.size === 0 && info.profiles.size > 0) {
  //   ByProfile.get('')
  //     ?.delete(tk)
  // }

  // if (info.profiles.size === 0) {
  //   profileKeys('')
  //     .add(tk)
  // } else {
  //   for (const profile of info.profiles) {
  //     profileKeys(profile)
  //       .add(tk)
  //   }
  // }
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
 *
 * @framework
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
 *
 * @framework
 */
export function hasInjectable(key: Key): boolean {
  return Injectables.has(key)
}

/**
 * Gets the injection metadata for the given object.
 *
 * @framework
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
 *
 * @framework
 */
export function getBindingConfiguration(key: Key): DecoratedBindingConfig | undefined {
  return Bindings.get(notNil(key))
}

function getOrCreateBindingConfiguration(key: Key): DecoratedBindingConfig {
  let binding = Bindings.get(key)
  if (!binding) {
    binding = new DecoratedBindingConfig(key)
    Bindings.set(key, binding)
  }

  return binding
}

/**
 * Gets the binding configurations for the given active profiles.
 * The container uses this function to retrieve all decorated bindings configured for the given profiles.
 *
 * @framework
 */
export function getBindingConfigurations(
  activeProfiles: ReadonlySet<Identifier>,
): IterableIterator<[Key, DecoratedBindingConfig]> {
  const ref = Bindings
  return (function* () {
    for (const [key, config] of ref) {
      const profiles = config.getProfiles
      if (!profiles || profiles.size === 0) {
        yield [key, config]
      } else {
        for (const p of profiles) {
          if (activeProfiles.has(p)) {
            yield [key, config]
            break
          }
        }
      }
    }
  })()
}

/**
 * Gets the provided bindings from configuration classes for the given active profiles.
 *
 * @framework
 */
export function providedBindingConfigurations(
  activeProfiles: ReadonlySet<Identifier>,
): Array<[Key, DecoratedBindingConfig]> {
  const seen = new Set<DecoratedBindingConfig>()
  const result: Array<[Key, DecoratedBindingConfig]> = []
  const noProfileEntries = ProvidedBindings.get('') ?? []

  for (const entry of noProfileEntries) {
    if (!seen.has(entry[1])) {
      seen.add(entry[1])
      result.push(entry)
    }
  }

  for (const profile of activeProfiles) {
    const profileEntries = ProvidedBindings.get(profile) ?? []
    for (const entry of profileEntries) {
      if (!seen.has(entry[1])) {
        seen.add(entry[1])
        result.push(entry)
      }
    }
  }

  return result
}

/**
 * Configures a provided binding from a configuration class.
 *
 * @framework
 */
export function addProvidedBindings<T>(key: Key<T>, config: DecoratedBindingConfig): void {
  notNil(key)
  notNil(config)

  const ps = config.getProfiles
  const profilesToRegister = ps && ps.size > 0 ? ps : new Set<Identifier>([''])
  for (const profile of profilesToRegister) {
    injectablesPerProfile(profile)
      .push([key, config])
  }
}

/**
 * Converts a binding decorator configuration to a binding configuration.
 *
 * @framework
 */
export function decoratorConfigToBinding<T>(config: DecoratedBindingConfig): Binding<T> {
  return config.binding()
}

function injectablesPerProfile(profile: Identifier): Array<[Key, DecoratedBindingConfig]> {
  let arr = ProvidedBindings.get(profile)
  if (!arr) {
    arr = []
    ProvidedBindings.set(profile, arr)
  }
  return arr
}

// Testing Utilities

/**
 * Represents a snapshot of the registry.
 *
 * @testing
 */
export interface DecoratorRegistrySnapshot {
  readonly bindings: Map<Key, DecoratedBindingConfig>
  readonly byProfile: Map<Identifier, Set<Key>>
  readonly providedBindings: Map<Identifier, Array<[Key, DecoratedBindingConfig]>>
  readonly injectables: Set<Key>
}

/**
 * Creates a snapshot of the registry.
 *
 * @testing
 */
export function snapshotDecoratorRegistry(): DecoratorRegistrySnapshot {
  return {
    bindings: new Map(Bindings),
    byProfile: new Map([...ByProfile.entries()].map(([k, v]) => [k, new Set(v)])),
    providedBindings: new Map([...ProvidedBindings.entries()].map(([k, v]) => [k, [...v]])),
    injectables: new Set(Injectables),
  }
}

/**
 * Restores the registry from a snapshot.
 *
 * @testing
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

  ProvidedBindings.clear()
  for (const [k, v] of snapshot.providedBindings) {
    ProvidedBindings.set(k, [...v])
  }

  Injectables.clear()
  for (const k of snapshot.injectables) {
    Injectables.add(k)
  }
}
