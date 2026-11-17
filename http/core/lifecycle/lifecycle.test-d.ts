import { expectTypeOf } from 'vitest'

import type { HTTPSetupContext } from '../../plugin.js'
import type { ContextPlatform } from '../server/platform.js'
import type { HookFn, SendPayload } from './lifecycle.js'
import type { RouteDefinition } from './route_definition.js'

/** What each hook point's function is handed, and that a request hook's context is the engine's. */
expectTypeOf<Parameters<HookFn<'onSend'>>[1]>().toEqualTypeOf<SendPayload>()
expectTypeOf<Parameters<HookFn<'onError'>>[1]>().toEqualTypeOf<Error>()
expectTypeOf<Parameters<HookFn<'onRoute'>>>().toEqualTypeOf<[RouteDefinition, HTTPSetupContext<unknown>]>()
expectTypeOf<Parameters<HookFn<'onReady'>>>().toEqualTypeOf<[HTTPSetupContext<unknown>]>()

expectTypeOf<Parameters<HookFn<'onRequest'>>[0]['platform']>().toEqualTypeOf<ContextPlatform>()

// @ts-expect-error -- preValidation is not a hook point
type _NotAHook = HookFn<'preValidation'>
