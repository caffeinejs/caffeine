import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

type RunOnce = () => Promise<unknown>

async function loadRunOnce(builtPath: string): Promise<RunOnce> {
  try {
    await access(builtPath)
  } catch {
    throw new Error(`Compiled output not found at: ${builtPath}\nRun: npm run build -w @caffeinejs/benchmarks`)
  }

  const mod = (await import(pathToFileURL(builtPath).href)) as { runOnce: RunOnce }
  return mod.runOnce
}

const runCaffeine = await loadRunOnce(resolve(__dirname, '..', 'dist', 'testing', 'caffeine', 'run.js'))
const runNest = await loadRunOnce(resolve(__dirname, '..', 'dist', 'testing', 'nestjs', 'run.js'))

void test('caffeine GET /hello', async () => {
  assert.deepEqual(await runCaffeine(), { hello: 'world' })
})

void test('nestjs GET /hello', async () => {
  assert.deepEqual(await runNest(), { hello: 'world' })
})
