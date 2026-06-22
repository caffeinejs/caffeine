/**
 * Runtime detection utilities.
 * Inspired by https://github.com/fastify/fastify-autoload
 */

type ProcessWithPreload = NodeJS.Process & { _preload_modules?: string[] }

const cache: Record<string, boolean> = {}

let processArgv: string[] | undefined
let preloadModules: string[] | undefined

export const Runtime = {
  get bun(): boolean {
    cache.bun ??= 'Bun' in globalThis
    return cache.bun
  },

  get deno(): boolean {
    cache.deno ??= 'Deno' in globalThis
    return cache.deno
  },

  get vitest(): boolean {
    cache.vitest ??= checkEnvVariable('VITEST', 'true') || checkEnvVariable('VITEST_WORKER_ID')
    return cache.vitest
  },

  get jest(): boolean {
    cache.jest ??= checkEnvVariable('JEST_WORKER_ID')
    return cache.jest
  },

  get babelNode(): boolean {
    cache.babelNode ??= checkProcessArgv('babel-node')
    return cache.babelNode
  },

  get swc(): boolean {
    cache.swc
      ??= checkPreloadModules('@swc/register')
        || checkPreloadModules('@swc-node/register')
        || checkProcessArgv('.bin/swc-node')
    return cache.swc
  },

  get tsNode(): boolean {
    cache.tsNode
      ??= Symbol.for('ts-node.register.instance') in process || checkProcessArgv('ts-node/esm') || !!process.env.TS_NODE_DEV
    return cache.tsNode
  },

  get tsm(): boolean {
    cache.tsm ??= checkPreloadModules('tsm')
    return cache.tsm
  },

  get esbuild(): boolean {
    cache.esbuild ??= checkPreloadModules('esbuild-register')
    return cache.esbuild
  },

  get tsx(): boolean {
    preloadModules ??= (process as ProcessWithPreload)._preload_modules ?? []
    cache.tsx ??= preloadModules.some(m => m.includes('tsx'))
    return cache.tsx
  },

  get supportNativeTypeScript(): boolean {
    cache.supportNativeTypeScript
      ??= process.features?.typescript !== undefined && process.features.typescript !== false
    return cache.supportNativeTypeScript
  },

  get supportTypeScript(): boolean {
    cache.supportTypeScript
      ??= checkEnvVariable('DICAF_AUTOLOAD_TYPESCRIPT')
        || Runtime.bun
        || Runtime.deno
        || Runtime.tsNode
        || Runtime.vitest
        || Runtime.babelNode
        || Runtime.jest
        || Runtime.swc
        || Runtime.tsm
        || Runtime.tsx
        || Runtime.esbuild
        || Runtime.supportNativeTypeScript
    return cache.supportTypeScript
  },
}

function checkProcessArgv(moduleName: string): boolean {
  processArgv ??= (process.execArgv ?? []).concat(process.argv ?? [])
  return processArgv.some(arg => arg.indexOf(moduleName) >= 0)
}

function checkPreloadModules(moduleName: string): boolean {
  preloadModules ??= (process as ProcessWithPreload)._preload_modules ?? []
  return preloadModules.includes(moduleName)
}

function checkEnvVariable(name: string, value?: string): boolean {
  return value ? process.env[name] === value : process.env[name] !== undefined
}
