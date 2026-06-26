import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { generate } from '../generator.js'
import { loadConfig } from '../config.js'
import { scan } from '../scanner.js'

export interface CaffeineViteOptions {
  configPath?: string
  cwd?: string
}

export function caffeineVite(opts: CaffeineViteOptions = {}): Plugin {
  const cwd = opts.cwd ?? process.cwd()
  let outputPath: string

  return {
    name: 'caffeine',
    async buildStart() {
      const config = await loadConfig(cwd, opts.configPath)
      const { include, exclude = [], output, importExtension = '.js' } = config.generate

      outputPath = resolve(cwd, output)
      const files = await scan({ root: cwd, include, exclude: [...exclude, output] })
      await generate({ files, output: outputPath, importExtension })
    },
    configureServer(server) {
      const handle = async (path: string) => {
        if (!outputPath) {
          return
        }
        const outputDir = dirname(outputPath)
        if (!path.startsWith(outputDir)) {
          return
        }

        const config = await loadConfig(cwd, opts.configPath)
        const { include, exclude = [], output, importExtension = '.js' } = config.generate
        const files = await scan({ root: cwd, include, exclude: [...exclude, output] })
        const changed = await generate({ files, output: resolve(cwd, output), importExtension })
        if (changed) {
          server.restart()
        }
      }

      server.watcher.on('add', handle)
      server.watcher.on('unlink', handle)
    },
  }
}
