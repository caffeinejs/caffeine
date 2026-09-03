import Module, { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// typescript-eslint needs TypeScript 6's compiler API. Root `tsc` is 7.0 (no API);
// `require('typescript')` from the hoisted package would resolve to 7 without this.
const requireFromPlugin = createRequire(fileURLToPath(new URL('./package.json', import.meta.url)))
const typescript6Main = requireFromPlugin.resolve('typescript')
const typescript6Root = dirname(requireFromPlugin.resolve('typescript/package.json'))
const tsserverlibrary = requireFromPlugin.resolve('typescript/lib/tsserverlibrary')

type ResolveFilename = (request: string, parent: unknown, isMain: boolean, options?: unknown) => string

const moduleInternal = Module as unknown as { _resolveFilename: ResolveFilename }
const original = moduleInternal._resolveFilename

moduleInternal._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === 'typescript') {
    return typescript6Main
  }
  if (request === 'typescript/lib/tsserverlibrary') {
    return tsserverlibrary
  }
  if (request.startsWith('typescript/')) {
    return join(typescript6Root, request.slice('typescript/'.length))
  }
  return original.call(this, request, parent, isMain, options)
}
