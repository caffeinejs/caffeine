import { buildStatic, verifyStatic } from '@caffeinejs/static/build'

const [command, flag, root, ...extra] = process.argv.slice(2)

if (
  (command !== 'build' && command !== 'verify') ||
  flag !== '--root' ||
  !root ||
  root.startsWith('--') ||
  extra.length
) {
  console.error('Usage: caffeine-static <build|verify> --root DIR')
  process.exitCode = 2
} else {
  try {
    const { files, variants, bytes } = command === 'build' ? await buildStatic({ root }) : await verifyStatic({ root })
    console.log(`${files} files, ${variants} variants, ${bytes} bytes`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
