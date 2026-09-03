import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import type { Plugin } from 'vite'

export interface CaffeineViteOptions {
  configPath?: string
  cwd?: string
}

export function caffeineVite(opts: CaffeineViteOptions = {}): Plugin {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd()

  const runGenerate = (): void => {
    const args = ['generate', '--cwd', cwd]
    if (opts.configPath) {
      args.push('--config', opts.configPath)
    }
    const result = spawnSync('caffeine', args, { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error('caffeine generate failed')
    }
  }

  return {
    name: 'caffeine',
    buildStart() {
      runGenerate()
    },
    configureServer(server) {
      server.watcher.on('add', runGenerate)
      server.watcher.on('unlink', runGenerate)
    },
  }
}
