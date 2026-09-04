import { loadConfig } from '../../config.js'
import { generateModuleGraph } from './module_graph_generator.js'

const KINDS = ['modules'] as const

type Kind = (typeof KINDS)[number]

export interface GenerateOptions {
  cwd: string
  config?: string
  kind?: string
}

export async function run(opts: GenerateOptions): Promise<void> {
  const kind = parseKind(opts.kind)
  const config = await loadConfig(opts.cwd, opts.config)

  if (kind === 'modules') {
    if (!config.modules) {
      throw new Error('Cannot generate modules: config does not define "modules"')
    }

    const result = await generateModuleGraph({ cwd: opts.cwd, config: config.modules })
    console.log(
      result.changed ? `[caffeine] generated modules (${result.modules} modules)` : `[caffeine] up to date modules`,
    )
  }
}

function parseKind(kind: string | undefined): Kind {
  if (kind === undefined || kind === '') {
    throw new Error(`Cannot generate: missing kind\nUsage: caffeine generate <kind>\nKinds: ${KINDS.join(', ')}`)
  }
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Cannot generate: unknown kind "${kind}"\nKinds: ${KINDS.join(', ')}`)
  }
  return kind as Kind
}
