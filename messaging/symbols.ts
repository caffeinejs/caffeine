import { token } from '@caffeinejs/di'

import type { MessageBus } from './bus.js'
import type { MessagingContainer } from './engine.js'
import type { MessagingRuntime } from './runtime.js'

/** The default binder instance name used when a messaging integration is declared without an explicit name. */
export const DEFAULT_BINDER = 'default'

/**
 * Well-known label/tag symbols for the portable messaging layer.
 *
 * - `MESSAGE_HANDLER` labels every `@MessageHandler` class (discovery, like the HTTP `CONTROLLER` label).
 * - `MESSAGING_CONTAINER` labels every per-instance dispatch engine so the plugin can start/stop them all.
 * - `MESSAGING_BINDER` tags a handler class with the name of the binder instance it belongs to.
 */
export const Keys = {
  MESSAGE_HANDLER: Symbol.for('@caffeinejs/messaging:handler'),
  MESSAGING_CONTAINER: Symbol.for('@caffeinejs/messaging:container'),
  MESSAGING_BINDER: Symbol.for('@caffeinejs/messaging:binder'),
}

/** Internal: the DI key of the binder-instance runtime seam for a named instance. */
export function runtimeKey(name: string) {
  return token<MessagingRuntime>(Symbol.for(`@caffeinejs/messaging:runtime:${name}`))
}

/** Internal: the DI key of the dispatch engine for a named messaging integration. */
export function containerKey(name: string) {
  return token<MessagingContainer>(Symbol.for(`@caffeinejs/messaging:engine:${name}`))
}

/**
 * The DI key of the `MessageBus` for a named messaging integration. The default integration's bus is also bound
 * under the `MessageBus` class itself (this symbol is a name alias on it), so default users may inject either.
 */
export function busKey(name: string = DEFAULT_BINDER) {
  return token<MessageBus>(Symbol.for(`@caffeinejs/messaging:bus:${name}`))
}
