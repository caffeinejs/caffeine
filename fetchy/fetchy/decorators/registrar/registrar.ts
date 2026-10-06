import '../../polyfill.js'
import { ClassBuilder, MethodBuilder } from './builders.js'

// Every registry is keyed by a class's decorator metadata object (`context.metadata`), which the class owns as
// `Symbol.metadata` once it is defined.
const MethodRegistry = new WeakMap<object, Map<string | symbol, MethodBuilder>>()
const ClassRegistry = new WeakMap<object, ClassBuilder>()

export function configureMethod(
  ctx: ClassMethodDecoratorContext | ClassFieldDecoratorContext,
  mut: (spec: MethodBuilder) => void,
): MethodBuilder {
  let methods = MethodRegistry.get(ctx.metadata)

  if (!methods) {
    methods = new Map<string | symbol, MethodBuilder>()
    MethodRegistry.set(ctx.metadata, methods)
  }

  let method = methods.get(ctx.name)

  if (!method) {
    method = new MethodBuilder(ctx.name)
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

/**
 * A class in a client's constructor chain that carries fetchy configuration.
 */
export interface DeclaringClass {
  readonly owner: Function
  readonly classBuilder: ClassBuilder | undefined
  readonly methods: readonly MethodBuilder[]
}

/**
 * Lists the classes from `target` up its constructor chain that carry fetchy configuration, the root first.
 *
 * A class counts only through the metadata object it owns. tsc and esbuild link a subclass's metadata to its
 * parent's, SWC only when the subclass has a class decorator, so reading through that link would find a base class's
 * members on its subclass under one compiler and not under another. A metadata object owned twice, as when a mixin
 * copies a class's statics, counts once, for the class closest to the root.
 */
export function getDeclaringClasses(target: Function): DeclaringClass[] {
  const found: [Function, object][] = []

  for (let C: unknown = target; typeof C === 'function' && C !== Function.prototype; C = Object.getPrototypeOf(C)) {
    if (!Object.hasOwn(C, Symbol.metadata)) {
      continue
    }

    const metadata: unknown = (C as { [Symbol.metadata]?: unknown })[Symbol.metadata]

    if (typeof metadata === 'object' && metadata !== null) {
      found.push([C, metadata])
    }
  }

  const chain: DeclaringClass[] = []
  const seen = new Set<object>()

  for (let i = found.length - 1; i >= 0; i--) {
    const [owner, metadata] = found[i]

    if (seen.has(metadata)) {
      continue
    }

    seen.add(metadata)

    const classBuilder = ClassRegistry.get(metadata)
    const methods = [...(MethodRegistry.get(metadata)?.values() ?? [])]

    if (classBuilder !== undefined || methods.length > 0) {
      chain.push({ owner, classBuilder, methods })
    }
  }

  return chain
}
