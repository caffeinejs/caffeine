import { tsImport } from 'tsx/esm/api'

// tsx does not register its ESM hooks in worker threads (it checks isMainThread).
// tsImport creates a fresh tsx registration scoped to this import chain, which
// lets the TypeScript worker implementation run with full decorator support.
await tsImport('./_worker_di_impl.ts', import.meta.url)
