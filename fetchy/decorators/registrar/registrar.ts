import { ClassBuilder, MethodBuilder } from './builders.js'

// `Symbol.metadata` is not yet a native well-known symbol in current JS engines. Compilers that
// implement the decorator metadata proposal (e.g. swc, TypeScript) fall back to
// `Symbol.for('Symbol.metadata')` when the native symbol is absent, so the literal `Symbol.metadata`
// must be polyfilled to that same registered symbol here — before any decorated class is evaluated —
// or `SomeClass[Symbol.metadata]` will never match what the compiled decorator helper actually wrote.
// This is only needed because `FetchyClient.create()` looks up `TargetAPI[Symbol.metadata]` as a
// WeakMap key from outside decorator scope; `ctx.metadata` itself is never mutated below, only used
// as an opaque WeakMap key, matching how `@caffeinejs/http`'s own registrar uses it.
;(Symbol as { metadata?: symbol }).metadata ??= Symbol.for('Symbol.metadata')

const MethodRegistry = new WeakMap<object, Map<string | symbol, MethodBuilder>>()
const ClassRegistry = new WeakMap<object, ClassBuilder>()

export function configureMethod(
  ctx: ClassMethodDecoratorContext,
  mut: (spec: MethodBuilder) => void,
): MethodBuilder {
  let methods = MethodRegistry.get(ctx.metadata)

  if (!methods) {
    methods = new Map<string | symbol, MethodBuilder>()
    MethodRegistry.set(ctx.metadata, methods)
  }

  let method = methods.get(ctx.name)

  if (!method) {
    method = new MethodBuilder()
    methods.set(ctx.name, method)
  }

  mut(method)

  return method
}

export function configureClass(ctx: ClassDecoratorContext, mut: (spec: ClassBuilder) => void): void {
  let cur = ClassRegistry.get(ctx.metadata)

  if (!cur) {
    cur = new ClassBuilder()
    ClassRegistry.set(ctx.metadata, cur)
  }

  mut(cur)
}

export function getMethodBuilders(metadata: object): ReadonlyMap<string | symbol, MethodBuilder> {
  return MethodRegistry.get(metadata) ?? new Map()
}

export function getClassBuilder(metadata: object): ClassBuilder | undefined {
  return ClassRegistry.get(metadata)
}
