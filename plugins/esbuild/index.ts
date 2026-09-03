import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { Plugin } from 'esbuild'

export interface CaffeineEsbuildOptions {
  configPath?: string
  cwd?: string
}

export function caffeineEsbuild(opts: CaffeineEsbuildOptions = {}): Plugin {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()

  return {
    name: 'caffeine',
    setup(build) {
      build.onStart(() => {
        const args = ['generate', '--cwd', cwd]
        if (opts.configPath) {
          args.push('--config', opts.configPath)
        }
        const result = spawnSync('caffeine', args, { stdio: 'inherit' })
        if (result.status !== 0) {
          throw new Error('caffeine generate failed')
        }
      })
    },
  }
}
