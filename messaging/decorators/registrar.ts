import { createAnnotation, ErrInvalidDecorator, reflect } from '@caffeinejs/di'
import type { ParameterPickOptions } from '@caffeinejs/std/framework'

import type { Message } from '../message.js'

/**
 * The frozen per-method contract the dispatch engine consumes: a handler method bound to one inbound binding
 * name, plus how its arguments are extracted. Binder-neutral — the binding's `via` (in the registry) decides
 * which binder delivers to it.
 */
export interface ConsumeSpec {
  handlerName: string | symbol
  binding: string
  parameters?: ParameterPickOptions<Message>[]
}

// A handler sees only the methods it declares itself, as it always has.
export const ConsumeBinding = createAnnotation.on('method')<string>({ inherit: 'own' })
export const ConsumeParams = createAnnotation.on('method')<ParameterPickOptions<Message>[]>({ inherit: 'own' })
export const Handler = createAnnotation.on('class')({ inherit: 'own' })

/** Called by `@MessageHandler` while the class is decorated: every `@MessageParams` method needs a `@Consume`. */
export function checkHandler(context: ClassDecoratorContext): void {
  for (const name of reflect.members(context, ConsumeParams).keys()) {
    if (reflect.get(context, ConsumeBinding, name) === undefined) {
      throw new ErrInvalidDecorator(
        `Cannot apply @MessageParams to method "${String(name)}": the method has no @Consume binding`,
      )
    }
  }
}

/** Reads the `@Consume` specs of a handler class (by constructor). */
export function getHandlerConsumes(target: object): ConsumeSpec[] {
  const specs: ConsumeSpec[] = []
  for (const [handlerName, binding] of reflect.members(target, ConsumeBinding)) {
    const parameters = reflect.get(target, ConsumeParams, handlerName)
    specs.push(Object.freeze({ handlerName, binding, ...(parameters !== undefined ? { parameters } : {}) }))
  }

  return specs
}
