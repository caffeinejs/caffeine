import { cpSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { globby } from 'globby'

const jsFiles = await globby('dist/esm/**/*.js')

await build({
  entryPoints: jsFiles,
  format: 'cjs',
  platform: 'node',
  bundle: false,
  outbase: 'dist/esm',
  outdir: 'dist/commonjs',
})

cpSync('dist/esm', 'dist/commonjs', {
  recursive: true,
  filter: src => !src.endsWith('.js'),
})

writeFileSync('dist/commonjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n')
