/**
 * DI key for the assembled `@fastify/view` options ({@link ViewOptions}). Bound by
 * `app.view(v => v.engine(...).root(...))`. When unbound, the view feature is inert — the plugin is not
 * registered and returning a {@link ViewResult} raises {@link ErrConfiguration}.
 */
export const kViewOptions = Symbol.for('@caffeinejs/http:view.options')
