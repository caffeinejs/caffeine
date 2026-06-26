import { resolve } from 'node:path'
import type { Plugin } from 'esbuild'
import { generate } from '../generator.js'
import { loadConfig } from '../config.js'
import { scan } from '../scanner.js'

export interface CaffeineEsbuildOptions {
  configPath?: string
  cwd?: string
}

export function caffeineEsbuild(opts: CaffeineEsbuildOptions = {}): Plugin {
  const cwd = opts.cwd ?? process.cwd()

  return {
    name: 'caffeine',
    setup(build) {
      build.onStart(async () => {
        const config = await loadConfig(cwd, opts.configPath)
        const { include, exclude = [], output, importExtension = '.js' } = config.generate
        const files = await scan({ root: cwd, include, exclude: [...exclude, output] })
        await generate({ files, output: resolve(cwd, output), importExtension })
      })
    },
  }
}
