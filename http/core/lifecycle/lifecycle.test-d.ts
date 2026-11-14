import { expectTypeOf } from 'vitest'

import type { AnyAdapterTypes, HTTPSetupContext } from '../../adapter.js'
import type { HookFn, SendPayload } from './lifecycle.js'
import type { RouteDefinition } from './route_definition.js'

/** What each hook point's function is handed, and that a hook written for no adapter still sees a usable context. */
expectTypeOf<Parameters<HookFn<'onSend'>>[1]>().toEqualTypeOf<SendPayload>()
expectTypeOf<Parameters<HookFn<'onError'>>[1]>().toEqualTypeOf<Error>()
expectTypeOf<Parameters<HookFn<'onRoute'>>>().toEqualTypeOf<[RouteDefinition, HTTPSetupContext<unknown>]>()
expectTypeOf<Parameters<HookFn<'onReady'>>>().toEqualTypeOf<[HTTPSetupContext<unknown>]>()

// `never`, the adapter of code written for none, must not make the context's platform `never`.
expectTypeOf<Parameters<HookFn<'onRequest', unknown, never>>[0]['platform']>().toEqualTypeOf<
  AnyAdapterTypes['platform']
>()

// @ts-expect-error -- preValidation is not a hook point
type _NotAHook = HookFn<'preValidation'>
