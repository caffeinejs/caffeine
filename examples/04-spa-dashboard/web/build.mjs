import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

import { build } from 'esbuild'

// The front-end build. Deliberately small and dependency-free apart from esbuild: the point of this example
// is the server, and a real framework build would only obscure what the server has to do.
//
// What it produces is what `@caffeinejs/static` is configured for:
//
//   * content-hashed names under `assets/`, so `immutableAssets()` can pin them for a year;
//   * `index.html` rewritten to point at those names, kept OUT of `assets/` so it is revalidated hourly;
//   * a `.br` and a `.gz` beside EVERY file, for `preCompressed`. Every file, not just the bundle — a file
//     with no sibling costs @fastify/static four failed filesystem probes on every request.

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'dist')

/** Brotli at a level worth the build time; the files are written once and served many times. */
function compress(source) {
  return {
    br: brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
      },
    }),
    gz: gzipSync(source, { level: 9 }),
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else {
      yield path
    }
  }
}

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

  let files = 0
  for await (const path of walk(out)) {
    const source = await readFile(path)
    const { br, gz } = compress(source)
    await writeFile(`${path}.br`, br)
    await writeFile(`${path}.gz`, gz)
    files++
  }

  console.log(`built ${files} files into ${relative(process.cwd(), out)} (${js}, ${css}), each with .br and .gz`)
}

await main()
