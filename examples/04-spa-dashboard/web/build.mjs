import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildStatic } from '@caffeinejs/static/build'
import { build } from 'esbuild'

// The front-end build. Deliberately small and dependency-free apart from esbuild and `buildStatic()`: the point of this example
// is the server, and a real framework build would only obscure what the server has to do.
//
// What it produces is what `@caffeinejs/static` is configured for:
//
//   * content-hashed names under `assets/`, so the mount's `immutable: ['assets/**']` can pin them for a year;
//   * `index.html` rewritten to point at those names, kept OUT of `assets/` so it is revalidated on every use;
//   * `buildStatic()` last: a `.br` and a `.gz` beside each file worth compressing, and the manifest the
//     mount serves from, so the server reads no file system metadata per request.

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')

async function main() {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const result = await build({
    entryPoints: [join(here, 'src/main.js')],
    outdir: out,
    entryNames: 'assets/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  })

  // esbuild picks the hashes, so the template has to be told what they turned out to be.
  const emitted = Object.keys(result.metafile.outputs).map(path => `/${relative(out, path).split('\\').join('/')}`)
  const js = emitted.find(path => path.endsWith('.js'))
  const css = emitted.find(path => path.endsWith('.css'))

  if (!js || !css) {
    throw new Error(`Expected a hashed .js and .css in the build output, got: ${emitted.join(', ')}`)
  }

  const template = await readFile(join(here, 'index.html'), 'utf8')
  await writeFile(join(out, 'index.html'), template.replace('%JS%', js).replace('%CSS%', css))

  // The root-level files a real site ships. Copied verbatim: they are not bundled and not hashed, because
  // their URLs are fixed by browsers, crawlers and the manifest spec.
  await cp(join(here, 'public'), out, { recursive: true })

  const report = await buildStatic({ root: out })

  console.log(
    `built ${report.files} files into ${relative(process.cwd(), out)} (${js}, ${css}), with ${report.variants} compressed variants`,
  )
}

await main()
