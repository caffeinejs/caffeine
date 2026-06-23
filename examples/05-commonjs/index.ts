import { join } from 'node:path'
import { DiCaf, scan } from '@caffeinejs/core'
import type { Greeter } from './services/greeter.js'

async function main(): Promise<string> {
  await scan({ dir: join(__dirname, 'services') })

  const di = new DiCaf()
  await di.init()

  return di.get<Greeter>('greeter').greet('World')
}

main()
  .then(result => console.log(result))
  .finally(() => console.log('Done'))
