import { newTestContainer, testClient } from '@caffeinejs/testing'

import { createContainer } from './app.js'
import { hello } from './hello.routes.js'

export async function runOnce(): Promise<unknown> {
  const container = newTestContainer(createContainer()).build()
  await using client = testClient(hello, { container })
  const res = await client.hello.get()
  if (res.status !== 200) {
    throw new Error(`caffeine: GET /hello returned ${res.status}`)
  }
  return res.json()
}
