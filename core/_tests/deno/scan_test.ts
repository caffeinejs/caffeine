import assert from 'node:assert/strict'
import { DiCaf, ErrCannotLoadTypeScriptModule, scan } from '@caffeinejs/core'
import { DenoAutoloadConfig, kDenoMessage } from './_testdata/config.ts'
import { DenoAutoloadService } from './_testdata/service.ts'

const testdataDir = new URL('./_testdata', import.meta.url).pathname

Deno.test('scan public API is exported', () => {
  assert.equal(typeof scan, 'function')
  assert.equal(typeof ErrCannotLoadTypeScriptModule, 'function')
})

Deno.test('scan() scans a directory and decorators register for DiCaf resolution', async () => {
  await scan({ dir: testdataDir })

  const di = new DiCaf()
  await di.init()

  const svc = di.get(DenoAutoloadService)
  assert.ok(svc instanceof DenoAutoloadService)
  assert.equal(svc.greet(), 'hello-from-deno-autoload')

  assert.ok(di.get(DenoAutoloadConfig) instanceof DenoAutoloadConfig)
  assert.equal(di.get(kDenoMessage), 'deno-config-message')
})

Deno.test('scan() matchFilter as function restricts loaded files', async () => {
  const loaded = await scan({
    dir: testdataDir,
    matchFilter: p => p.endsWith('service.ts'),
  })

  assert.equal(loaded.length, 1)
  assert.ok(loaded[0]!.endsWith('service.ts'))
  assert.ok(!loaded.some(m => m.endsWith('config.ts')))
})

Deno.test('scan() ignoreFilter as function excludes matched files', async () => {
  const loaded = await scan({
    dir: testdataDir,
    ignoreFilter: p => p.endsWith('config.ts'),
  })

  assert.ok(!loaded.some(m => m.endsWith('config.ts')))
  assert.ok(loaded.some(m => m.endsWith('service.ts')))
})
