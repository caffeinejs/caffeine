import { resolve } from 'node:path'
import { loadConfig } from '../../config.js'
import { generate } from './generator.js'
import { generateModuleGraph } from './module_graph_generator.js'
import { generateModules } from './modules_generator.js'
import { scan } from './scanner.js'

export interface GenerateOptions {
  cwd: string
  config?: string
}

export async function run(opts: GenerateOptions): Promise<void> {
  const config = await loadConfig(opts.cwd, opts.config)

  if (!config.generate && !config.modules && !config.moduleGraph) {
    console.error('[caffeine] config must define at least one of: generate, modules, moduleGraph')
    process.exit(1)
  }

  const allOutputs = [
    config.generate?.output,
    config.modules?.output ?? 'app.mod.ts',
    ...(config.moduleGraph ? ['**/*.generated.mod.ts'] : []),
  ].filter((o): o is string => o !== undefined)

  if (config.generate) {
    const { include, exclude = [], output, importExtension = '.js' } = config.generate
    const outputPath = resolve(opts.cwd, output)
    const files = await scan({ root: opts.cwd, include, exclude: [...exclude, ...allOutputs] })
    const changed = await generate({ files, output: outputPath, importExtension })
    console.log(changed
      ? `[caffeine] generated ${output} (${files.length} files)`
      : `[caffeine] up to date ${output}`)
  }

  if (config.modules) {
    const { include, exclude = [], output = 'app.mod.ts', importExtension = '.js' } = config.modules
    const outputPath = resolve(opts.cwd, output)
    const files = await scan({ root: opts.cwd, include, exclude: [...exclude, ...allOutputs] })
    const changed = await generateModules({ files, output: outputPath, importExtension })
    console.log(changed
      ? `[caffeine] generated modules ${output} (${files.length} files)`
      : `[caffeine] up to date modules ${output}`)
  }

  if (config.moduleGraph) {
    const result = await generateModuleGraph({
      cwd: opts.cwd,
      config: {
        ...config.moduleGraph,
        exclude: [...(config.moduleGraph.exclude ?? []), ...allOutputs],
      },
    })
    console.log(result.changed
      ? `[caffeine] generated module graph (${result.modules} modules)`
      : `[caffeine] up to date module graph`)
  }
}
