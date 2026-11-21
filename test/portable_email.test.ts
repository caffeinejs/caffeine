import { execFile } from 'node:child_process'
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, findPackageJSON } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { buildTemplates } from '@caffeinejs/templating/build/node'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
const fixtures = new URL('./fixtures/portable-email/', import.meta.url)
const require = createRequire(import.meta.url)
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const workerd = (require('workerd') as { default: string }).default

describe('portable email consumer', { timeout: 30_000 }, () => {
  let project: string

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'caffeine-portable-email-'))
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await copyFile(new URL('tsconfig.json', fixtures), join(project, 'tsconfig.json'))
    await copyFile(new URL('consumer.ts.in', fixtures), join(project, 'consumer.ts'))
  })

  afterEach(async () => {
    await rm(project, { recursive: true, force: true })
  })

  function typecheck(cwd = project) {
    return run(process.execPath, [tsc, '--project', 'tsconfig.json', '--pretty', 'false'], { cwd })
  }

  function bundle(entry: string, cwd = project) {
    return build({
      absWorkingDir: cwd,
      entryPoints: [entry],
      outfile: 'bundle.mjs',
      bundle: true,
      platform: 'browser',
      // Keep the runtime read visible to workerd instead of substituting esbuild's browser default.
      define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
      format: 'esm',
      logLevel: 'silent',
    })
  }

  async function runWorker() {
    await copyFile(new URL('worker.mjs', fixtures), join(project, 'worker.mjs'))
    await copyFile(new URL('worker.capnp', fixtures), join(project, 'worker.capnp'))
    await bundle('worker.mjs')
    return run(workerd, ['test', 'worker.capnp'], { cwd: project })
  }

  it('type-checks and streams a Fetch response in a worker without runtime-specific globals', async () => {
    await typecheck()
    const { stdout, stderr } = await runWorker()
    expect(stdout + stderr).toContain('[ PASS ] portable-email')
  })

  it('exposes a JavaScript dependency that reads the Node environment at runtime', async () => {
    await writeFile(
      join(project, 'host-env.js'),
      "if (!process.env.NODE_ENV) {\n  throw new Error('Missing mode')\n}\n",
    )
    await appendFile(join(project, 'consumer.ts'), "\nimport './host-env.js'\n")
    await expect(runWorker()).rejects.toMatchObject({
      stderr: expect.stringContaining('ReferenceError: process is not defined'),
    })
  })

  it('rejects a deployment dependency that imports a Node builtin', async () => {
    await writeFile(join(project, 'consumer.ts'), "export { readFile } from 'node:fs/promises'\n")
    await expect(bundle('consumer.ts')).rejects.toThrow('Could not resolve "node:fs/promises"')
  })

  it('rejects a public package declaration that requires Node types', async () => {
    const dependency = join(project, 'node_modules', 'host-types')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.d.ts' }))
    await writeFile(join(dependency, 'index.d.ts'), 'export declare function payload(): Buffer\n')
    await writeFile(join(project, 'consumer.ts'), "export { payload } from 'host-types'\n")

    await expect(typecheck()).rejects.toMatchObject({
      stdout: expect.stringMatching(/host-types[/\\]index\.d\.ts[^\n]*Cannot find name 'Buffer'/),
    })
  })

  it('runs three compiled manifests after removing compiler code and template sources', async () => {
    const buildConsumer = join(project, 'build')
    const runtime = join(project, 'runtime')
    const assets = [
      { name: 'welcome', kind: 'html', locales: ['pt-BR'] },
      { name: 'welcome', kind: 'text', locales: ['pt-BR'] },
    ] as const
    const thirdParty = new URL('third-party-compiler/', fixtures)

    await stageTemplating(buildConsumer)
    await stageTemplating(runtime)
    // Build tooling may resolve its own platform binary. The build consumer gets no built-in template engines.
    for (const tool of ['esbuild', 'es-module-lexer']) {
      await symlink(
        dirname(packageManifest(tool, import.meta.url)),
        join(buildConsumer, 'node_modules', tool),
        'junction',
      )
    }
    await copyFile(new URL('adapter.ts.in', thirdParty), join(buildConsumer, 'adapter.ts'))
    await copyFile(new URL('format.js', thirdParty), join(buildConsumer, 'format.js'))
    await writeFile(join(buildConsumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await writeFile(
      join(buildConsumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'NodeNext',
          lib: ['ESNext', 'WebWorker'],
          types: [],
          strict: true,
          noEmit: true,
        },
        files: ['adapter.ts'],
      }),
    )
    const roots = join(buildConsumer, 'views')
    await mkdir(roots)
    for (const suffix of ['.receipt', '.txt.receipt']) {
      await copyFile(new URL(`welcome${suffix}`, thirdParty), join(roots, `welcome${suffix}`))
      await writeFile(join(roots, `welcome.pt-BR${suffix}`), 'Olá, {{name}}!')
    }
    await typecheck(buildConsumer)
    await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import { buildTemplates } from '@caffeinejs/templating/build/node'",
          "import { receiptCompiler } from './adapter.ts'",
          `await buildTemplates({ engine: receiptCompiler, roots: ['views'], assets: ${JSON.stringify(assets)}, outFile: 'receipt.mjs' })`,
          'try {',
          `  await buildTemplates({ engine: 'handlebars', roots: ['views'], assets: ${JSON.stringify(assets)}, outFile: 'missing.mjs' })`,
          "  throw new Error('Expected a diagnostic for the missing compiler peer')",
          '} catch (error) {',
          "  if (error.code !== 'ERR_TEMPLATE_CONFIGURATION' || !error.message.includes('handlebars') || error.message.includes(process.cwd())) {",
          '    throw error',
          '  }',
          '}',
        ].join('\n'),
      ],
      { cwd: buildConsumer },
    )
    for (const file of ['receipt.mjs', 'receipt.d.mts']) {
      await copyFile(join(buildConsumer, file), join(runtime, file))
    }

    for (const [engine, suffix, html, text] of [
      ['handlebars', 'hbs', '{{name}}', '{{name}}'],
      ['ejs', 'ejs', '<%= locals.name %>', '<%- locals.name %>'],
    ] as const) {
      for (const [locale, greeting] of [
        ['', 'Hello'],
        ['.pt-BR', 'Olá'],
      ]) {
        await writeFile(join(roots, `welcome${locale}.${suffix}`), `${greeting}, ${html}!`)
        await writeFile(join(roots, `welcome${locale}.txt.${suffix}`), `${greeting}, ${text}!`)
      }
      await buildTemplates({ engine, roots: [roots], assets, outFile: join(runtime, `${engine}.mjs`) })
    }
    expect(await readFile(join(runtime, 'handlebars.mjs'), 'utf8')).toContain('Copyright (C) 2011-2019 by Yehuda Katz')
    await rm(buildConsumer, { recursive: true, force: true })

    await copyFile(new URL('consumer.ts.in', fixtures), join(runtime, 'consumer.ts'))
    await copyFile(new URL('templating.ts.in', fixtures), join(runtime, 'templates.ts'))
    await appendFile(join(runtime, 'consumer.ts'), "\nexport { checkTemplates } from './templates.js'\n")
    await copyFile(new URL('tsconfig.json', fixtures), join(runtime, 'tsconfig.json'))
    await copyFile(new URL('worker.mjs', fixtures), join(runtime, 'standards.mjs'))
    await copyFile(new URL('worker.capnp', fixtures), join(runtime, 'worker.capnp'))
    await writeFile(
      join(runtime, 'worker.mjs'),
      [
        "import standards from './standards.mjs'",
        "import { checkTemplates } from './consumer.js'",
        'export { checkTemplates }',
        'export default {',
        '  async test() {',
        '    await standards.test()',
        '    await checkTemplates()',
        '  },',
        '}',
      ].join('\n'),
    )
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await typecheck(runtime)
    await bundle('worker.mjs', runtime)
    const { stdout, stderr } = await run(workerd, ['test', 'worker.capnp'], { cwd: runtime })
    expect(stdout + stderr).toContain('[ PASS ] portable-email')
    const check = "await (await import('./bundle.mjs')).checkTemplates()"
    await run(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '--eval', check], {
      cwd: runtime,
    })
    await run('bun', ['-e', check], { cwd: runtime })
  })
})

function packageManifest(name: string, from: string | URL): string {
  const path = findPackageJSON(name, from)
  if (path === undefined) {
    throw new Error(`Cannot locate the installed package "${name}"`)
  }
  return path
}

async function stageTemplating(project: string): Promise<void> {
  const templating = packageManifest('@caffeinejs/templating', import.meta.url)
  const fromTemplating = pathToFileURL(templating)
  const parse5 = packageManifest('parse5', fromTemplating)
  for (const [name, manifest] of [
    ['@caffeinejs/templating', templating],
    ['@caffeinejs/std', packageManifest('@caffeinejs/std', fromTemplating)],
    ['parse5', parse5],
    ['entities', packageManifest('entities', pathToFileURL(parse5))],
  ]) {
    const destination = join(project, 'node_modules', name)
    await mkdir(destination, { recursive: true })
    await copyFile(manifest, join(destination, 'package.json'))
    await cp(join(dirname(manifest), 'dist'), join(destination, 'dist'), { recursive: true })
  }
}
