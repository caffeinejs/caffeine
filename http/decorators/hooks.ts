import { ErrInvalidDecorator } from '@caffeinejs/di'
import { errMessage } from '@caffeinejs/std/err'

import type {
  OnErrorHook,
  OnSendHook,
  RequestHook,
  RequestHookName,
  RequestHooks,
} from '../core/lifecycle/lifecycle.js'
import { defineClassOrMemberDecorator } from './_decorator_util.js'
import {
  configureControllerHook,
  configureRoute,
  configureRouteGroup,
  hookDecoratorName,
} from './registrar/registrar.js'

type MethodDecorator = (target: Function, context: ClassMethodDecoratorContext) => void
type ClassOrMethodDecorator = (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext) => void

function hookDecorator<K extends RequestHookName>(point: K, fns: readonly RequestHooks[K][]): ClassOrMethodDecorator {
  // Decorators apply bottom-up: prepending keeps the order a reader sees them in.
  const withFunctions = defineClassOrMemberDecorator(
    (target, context) => configureRouteGroup(context, target, spec => spec.prependHooks(point, fns)),
    context => configureRoute(context, spec => spec.name(context.name).prependHooks(point, fns)),
  )

  return (target: unknown, context: ClassDecoratorContext | ClassMethodDecoratorContext): void => {
    if (fns.length > 0) {
      withFunctions(target as Function, context)
    } else if (context.kind === 'class') {
      const name = hookDecoratorName(point)
      throw new ErrInvalidDecorator(
        errMessage(`Cannot use @${name}() on a class: it names no hook to run`)
          .solutions(`Pass the hook: @${name}(fn)`)
          .reference('@caffeinejs/di', ErrInvalidDecorator)
          .build(),
      )
    } else {
      configureControllerHook(context, point)
    }
  }
}

/**
 * Runs once the route is matched, before the handler: `@OnRequest()` on a controller method makes the method the
 * hook for every route of the controller; `@OnRequest(fn)` on the controller or a route installs `fn` there.
 *
 * ```ts
 * @Controller('/pets')
 * @OnRequest(ctx => { ctx.state.set('started', performance.now()) })
 * class PetsController {
 *   @OnRequest()
 *   tenant(ctx: IContext) { ... }
 * }
 * ```
 *
 * @throws ErrInvalidDecorator for `@OnRequest()` on a class, which names no hook.
 */
export function OnRequest(): MethodDecorator
export function OnRequest(fn: RequestHook, ...fns: RequestHook[]): ClassOrMethodDecorator
export function OnRequest(...fns: RequestHook[]): ClassOrMethodDecorator {
  return hookDecorator('onRequest', fns)
}

/** Runs right before the handler. Forms as {@link OnRequest}. */
export function PreHandler(): MethodDecorator
export function PreHandler(fn: RequestHook, ...fns: RequestHook[]): ClassOrMethodDecorator
export function PreHandler(...fns: RequestHook[]): ClassOrMethodDecorator {
  return hookDecorator('preHandler', fns)
}

/**
 * Runs once the request is answered, before the answer goes out: may write the status and headers, and replace the
 * body (`undefined` keeps it, `null` sends none). Forms as {@link OnRequest}.
 */
export function OnSend(): MethodDecorator
export function OnSend(fn: OnSendHook, ...fns: OnSendHook[]): ClassOrMethodDecorator
export function OnSend(...fns: OnSendHook[]): ClassOrMethodDecorator {
  return hookDecorator('onSend', fns)
}

/** Runs once the answer has left. Forms as {@link OnRequest}. */
export function OnResponse(): MethodDecorator
export function OnResponse(fn: RequestHook, ...fns: RequestHook[]): ClassOrMethodDecorator
export function OnResponse(...fns: RequestHook[]): ClassOrMethodDecorator {
  return hookDecorator('onResponse', fns)
}

/** Runs when the request fails, before the error handlers answer it; it cannot handle it. Forms as {@link OnRequest}. */
export function OnError(): MethodDecorator
export function OnError(fn: OnErrorHook, ...fns: OnErrorHook[]): ClassOrMethodDecorator
export function OnError(...fns: OnErrorHook[]): ClassOrMethodDecorator {
  return hookDecorator('onError', fns)
}
