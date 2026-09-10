import { kBootstrap, kFeatureName, type BootstrapKit, type FeatureLifecycle } from '@caffeinejs/std'

import { AuthenticationExtension } from './authentication_extension.js'

/**
 * Registers the {@link AuthenticationExtension} unconditionally.
 *
 * The extension is always registered — configured or not — because it is what refuses an application that
 * protects a route and never configured authentication. When authentication *is* configured it adds the
 * `onRequest` hook; otherwise it either fails start-up or does nothing.
 */
export class AuthenticationConfigurer implements FeatureLifecycle {
  readonly [kFeatureName] = 'security';

  [kBootstrap](kit: BootstrapKit): void {
    kit.extensions.register(AuthenticationExtension, new AuthenticationExtension())
  }
}
