/**
 * Materializes a `ViewBuilder` / `ViewEngineBuilder` into its assembled `@fastify/view` options. Not exported
 * from the package barrel — only `view/plugin.ts` and `view/view_plugin.ts` (and this package's own tests)
 * need it.
 */
export const kBuild = Symbol('caffeine.view.build')
