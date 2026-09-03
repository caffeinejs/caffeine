import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { Message } from '../message.js'

/**
 * The frozen per-method contract the dispatch engine consumes: a handler method bound to one inbound binding
 * name, plus how its arguments are extracted. Binder-neutral — the binding's `via` (in the registry) decides
 * which binder delivers to it.
 */
export interface ConsumeSpec {
  handlerName: string
  binding: string
  parameters?: ParameterPickOptions<Message>[]
}

/** Accumulates one `@Consume` method's config before the class decorator freezes it. */
class ConsumeBuilder {
  readonly handlerName: string
  binding?: string
  parameters?: ParameterPickOptions<Message>[]

  constructor(handlerName: string) {
    this.handlerName = handlerName
  }

  toSpec(): ConsumeSpec {
    if (this.binding === undefined) {
      throw new TypeError(`@Consume on "${this.handlerName}": a binding name is required`)
    }
    return Object.freeze({
      handlerName: this.handlerName,
      binding: this.binding,
      ...(this.parameters !== undefined ? { parameters: this.parameters } : {}),
    })
  }
}

// Method decorators run before the class decorator, so they accumulate per-method builders keyed by the class's
// decorator metadata object; `@MessageHandler` then harvests them into the constructor-keyed registry.
const ConsumeRegistry = new WeakMap<object, Map<string, ConsumeBuilder>>()
const HandlerRegistry = new WeakMap<object, ConsumeSpec[]>()

/** Entry point every `@Consume` method decorator calls to mutate its accumulating builder. */
export function configureConsume(
  context: ClassMethodDecoratorContext,
  mutate: (builder: ConsumeBuilder) => void,
): void {
  const metadata = context.metadata
  let byMethod = ConsumeRegistry.get(metadata)
  if (byMethod === undefined) {
    byMethod = new Map()
    ConsumeRegistry.set(metadata, byMethod)
  }
  const name = String(context.name)
  let builder = byMethod.get(name)
  if (builder === undefined) {
    builder = new ConsumeBuilder(name)
    byMethod.set(name, builder)
  }
  mutate(builder)
}

/** Called by `@MessageHandler`: freezes this class's accumulated `@Consume` builders into the ctor registry. */
export function registerHandler(metadata: object, target: object): void {
  const byMethod = ConsumeRegistry.get(metadata)
  const specs = byMethod === undefined ? [] : [...byMethod.values()].map(builder => builder.toSpec())
  HandlerRegistry.set(target, specs)
}

/** Reads the frozen `@Consume` specs for a handler class (by constructor). */
export function getHandlerConsumes(target: object): ConsumeSpec[] {
  return HandlerRegistry.get(target) ?? []
}
