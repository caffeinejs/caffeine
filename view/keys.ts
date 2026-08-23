/**
 * DI key for the {@link ViewOptionsProvider} that groups every configured `@fastify/view` engine
 * registration (the default engine plus any named ones). Bound by `app.view(...)`. When unbound, the
 * view feature is inert — no engine is registered and returning a {@link ViewResult} raises
 * {@link ErrConfiguration}.
 */
export const kViewOptionsProvider = Symbol.for('@caffeinejs/view:options-provider')
