import type { Container } from '@caffeinejs/di'
import type { BootstrapKit } from '@caffeinejs/std'

/**
 * What an HTTP application hands everything it builds at start-up: an extension factory, a middleware factory, a
 * feature's server hook.
 *
 * Built once the container has initialized, so `container.get(...)` is legal, and `logger` is the one the logger
 * feature configured.
 */
export interface HTTPSetupContext<C = unknown> extends BootstrapKit<C> {
  container: Container
}
