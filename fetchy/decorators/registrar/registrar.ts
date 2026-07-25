import { ClassBuilder, MethodBuilder } from './builders.js'
import type { ClassSpec } from './builders.definition.js'

const MethodRegistry = new WeakMap<object, Map<string | symbol, MethodBuilder>>()
const ClassRegistry = new WeakMap<object, ClassBuilder>()

interface APIEntry {
  classSpec: ClassSpec
  methods: ReadonlyMap<string | symbol, MethodBuilder>
}

const APIRegistry = new WeakMap<Function, APIEntry>()

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
    method = new MethodBuilder()
    methods.set(ctx.name, method)
  }

  method.kind(ctx.kind)
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
 * Drains the `ctx.metadata`-keyed method registry into a registry keyed by the real class
 * constructor. Must be called from a class decorator (`@API()`) — method/field decorators always
 * run before any class decorator, so every method already registered under `ctx.metadata` (the
 * same object `@GET`/`@POST`/etc. saw) is complete by the time this runs.
 */
export function configureAPIAndRegisterMethods(
  ctx: ClassDecoratorContext,
  target: Function,
  mut: (spec: ClassBuilder) => void,
): void {
  let classBuilder = ClassRegistry.get(ctx.metadata)

  if (!classBuilder) {
    classBuilder = new ClassBuilder()
    ClassRegistry.set(ctx.metadata, classBuilder)
  }

  mut(classBuilder)

  const methods = MethodRegistry.get(ctx.metadata) ?? new Map<string | symbol, MethodBuilder>()

  APIRegistry.set(target, { classSpec: classBuilder.toClassSpec(), methods })
}

export function getAPI(target: Function): APIEntry | undefined {
  return APIRegistry.get(target)
}
