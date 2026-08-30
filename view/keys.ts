import { token } from '@caffeinejs/di'
import type { ViewOptionsProvider } from './options_provider.js'

/**
 * DI key for the {@link ViewOptionsProvider} that groups every configured `@fastify/view` engine
 * registration (the default engine plus any named ones). Bound by `app.view(...)`. When unbound, the
 * view feature is inert — no engine is registered and returning a {@link ViewResult} raises
 * {@link ErrConfiguration}.
 */
export const kViewOptionsProvider = token<ViewOptionsProvider>(Symbol.for('@caffeinejs/view:options-provider'))
