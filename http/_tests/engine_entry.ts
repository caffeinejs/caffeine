// What the engine project hands the suites in place of the Node entry: `node()` hands back no adapter's own.
import { fetchAdapter, type FetchAdapter } from '../core/server/hosting.js'

export const node = (): FetchAdapter => fetchAdapter
