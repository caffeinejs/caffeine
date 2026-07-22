import type { ParamDescriptor } from './internal/param_descriptor.js'

// `Symbol.metadata` is not yet a native well-known symbol in current JS engines. Compilers that
// implement the decorator metadata proposal (e.g. swc, TypeScript) fall back to
// `Symbol.for('Symbol.metadata')` when the native symbol is absent, so the literal `Symbol.metadata`
// must be polyfilled to that same registered symbol here — before any decorated class is evaluated —
// or `SomeClass[Symbol.metadata]` will never match what the compiled decorator helper actually wrote.
;(Symbol as { metadata?: symbol }).metadata ??= Symbol.for('Symbol.metadata')

const CLASS_META = Symbol('fetchy:class_meta')
const METHOD_META = Symbol('fetchy:method_meta')

export class ClassMeta {
  path = ''
  headers: Headers = new Headers()
  requestType: string | undefined = undefined
  responseType: string | undefined = undefined
}

export class MethodMeta {
  httpMethod = ''
  path = ''
  headers: Headers = new Headers()
  params: ParamDescriptor[] = []
  bodyIndex = -1
  argLen = 0
  formUrlEncoded = false
  requestType: string | undefined = undefined
  responseType: string | undefined = undefined
  invoker: ((...args: unknown[]) => unknown) | null = null
  /** Set once this method has been merged/validated/wired by a `FetchyClient.create()` call. */
  processed = false
}

interface FetchyMetadata {
  [CLASS_META]?: ClassMeta
  [METHOD_META]?: Map<string | symbol, MethodMeta>
}

function asFetchyMetadata(metadata: DecoratorMetadataObject): FetchyMetadata {
  return metadata as FetchyMetadata
}

function cloneClassMeta(source: ClassMeta): ClassMeta {
  const clone = new ClassMeta()
  clone.path = source.path
  clone.headers = new Headers(source.headers)
  clone.requestType = source.requestType
  clone.responseType = source.responseType
  return clone
}

/**
 * Returns the class's own {@link ClassMeta}, cloning it from an inherited (prototype-chain) copy
 * on first write so that mutating a subclass's metadata never corrupts its parent's.
 */
export function classMeta(metadata: DecoratorMetadataObject): ClassMeta {
  const meta = asFetchyMetadata(metadata)

  if (!Object.hasOwn(metadata, CLASS_META)) {
    meta[CLASS_META] = meta[CLASS_META] ? cloneClassMeta(meta[CLASS_META]) : new ClassMeta()
  }

  return meta[CLASS_META] as ClassMeta
}

/**
 * Returns the class's own method metadata {@link Map}, shallow-copying it from an inherited copy
 * on first write. Existing entries are shared by reference until a decorator in the subclass's own
 * body targets the same method name, at which point that entry is replaced, never mutated in place.
 */
function ownMethodMap(metadata: DecoratorMetadataObject): Map<string | symbol, MethodMeta> {
  const meta = asFetchyMetadata(metadata)

  if (!Object.hasOwn(metadata, METHOD_META)) {
    meta[METHOD_META] = meta[METHOD_META] ? new Map(meta[METHOD_META]) : new Map()
  }

  return meta[METHOD_META] as Map<string | symbol, MethodMeta>
}

/**
 * Returns the {@link MethodMeta} for the given method name, creating it (as an own entry) if absent.
 */
export function methodMeta(metadata: DecoratorMetadataObject, name: string | symbol): MethodMeta {
  const methods = ownMethodMap(metadata)
  let entry = methods.get(name)

  if (!entry) {
    entry = new MethodMeta()
    methods.set(name, entry)
  }

  return entry
}

/**
 * Read-only view of every method's metadata, including inherited entries resolved through the
 * prototype chain. Never triggers a copy-on-write clone.
 */
export function allMethodMeta(metadata: DecoratorMetadataObject): ReadonlyMap<string | symbol, MethodMeta> {
  return asFetchyMetadata(metadata)[METHOD_META] ?? new Map()
}

/**
 * Read-only view of the class-level defaults, including inherited values resolved through the
 * prototype chain. Never triggers a copy-on-write clone.
 */
export function readClassMeta(metadata: DecoratorMetadataObject): ClassMeta | undefined {
  return asFetchyMetadata(metadata)[CLASS_META]
}
