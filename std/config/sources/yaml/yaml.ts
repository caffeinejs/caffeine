import type { YAMLError } from 'yaml'

import { configDocuments, FileConfigSource, type FileConfigSourceOptions } from '../file/index.js'

/**
 * Configuration from a YAML file, with profile siblings layered over it as for any {@link FileConfigSource}.
 *
 * A file can hold several documents, split by `---`. Each applies in order as a layer of its own, so a later one
 * wins over an earlier one, and `explain()` names it: `file:./config/app.yaml#2` is the second. An empty document
 * adds nothing. Merge keys, `<<: *defaults`, are read.
 *
 * A parse error names the line and the column, never the text there: a config file may hold a secret. A warning,
 * such as a tag nothing resolves, fails the load as well, rather than leaving the value as text.
 */
export class YAMLConfigSource extends FileConfigSource {
  constructor(path: string, options: FileConfigSourceOptions = {}) {
    super(path, parseYAML, options)
  }
}

async function parseYAML(text: string): Promise<Record<string, unknown>> {
  // Loaded on first use, so an application that reads no YAML never pays for the parser.
  const { LineCounter, parseAllDocuments } = await import('yaml')
  const lineCounter = new LineCounter()
  const documents = parseAllDocuments(text, { merge: true, lineCounter, prettyErrors: false })

  for (const document of documents) {
    const problem: YAMLError | undefined = document.errors[0] ?? document.warnings[0]
    if (problem !== undefined) {
      const { line, col } = lineCounter.linePos(problem.pos[0])
      throw new Error(`${problem.message} at line ${line}, column ${col}`)
    }
  }

  return configDocuments(documents.map(document => document.toJS() as unknown))
}
