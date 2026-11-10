import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readManifest } from '@caffeinejs/static'
import { buildStatic } from '@caffeinejs/static/build'
import { KiB } from '@caffeinejs/std/bytes'

/** The built site every server serves, shared by path: each server is a process of its own. */
export const FIXTURE = join(tmpdir(), 'caffeine-bench-static')

/** A 2 KiB stylesheet, which the build compresses. */
export const STYLE = '/assets/style-0a1b2c3d.css'
/** A 100 KiB script, asked for without `Accept-Encoding` so it is sent as stored. */
export const SCRIPT = '/assets/app-4e5f6a7b.js'

/** Code that compresses as a real bundle does: repeated shapes, distinct names. */
function source(size: number, line: (i: number) => string): string {
  let text = ''

  for (let i = 0; text.length < size; i++) {
    text += line(i)
  }

  return text.slice(0, size)
}

/**
 * Writes the site and runs `buildStatic` over it, then copies each variant beside its file, where `@fastify/static`'s
 * `preCompressed` looks for it, so both servers read the same files and variants.
 */
export async function buildFixture(): Promise<void> {
  await rm(FIXTURE, { recursive: true, force: true })
  await mkdir(join(FIXTURE, 'assets'), { recursive: true })

  await writeFile(join(FIXTURE, 'index.html'), '<!doctype html><title>bench</title><div id="root"></div>\n')
  await writeFile(
    join(FIXTURE, STYLE),
    source(
      2 * KiB,
      i =>
        `.card-${i} { margin: ${i % 7}px; padding: ${i % 5}px; color: #${(i * 4099).toString(16).padStart(6, '0').slice(0, 6)}; }\n`,
    ),
  )
  await writeFile(
    join(FIXTURE, SCRIPT),
    source(100 * KiB, i => `export function handler${i}(event) { return event.value * ${i} + ${(i * 31) % 97}; }\n`),
  )

  await buildStatic({ root: FIXTURE })

  for (const [path, file] of Object.entries((await readManifest(FIXTURE)).files)) {
    for (const [encoding, variant] of Object.entries(file.variants)) {
      await copyFile(join(FIXTURE, variant.path), join(FIXTURE, `${path}${encoding === 'br' ? '.br' : '.gz'}`))
    }
  }
}
